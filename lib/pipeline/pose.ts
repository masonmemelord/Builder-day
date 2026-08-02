import "server-only";

import type { PoseLandmark } from "@/lib/types";
import type { ExtractedFrame } from "./frames";

export interface FramePose {
  frameIndex: number;
  landmarks: PoseLandmark[] | null;
  score: number | null;
}

/**
 * MoveNet's 17-point COCO topology, in keypoint-array order.
 *
 * This replaced MediaPipe's 33-point model: `@mediapipe/tasks-vision` is a
 * browser library that requires a DOM (`document is not defined` under Node),
 * so it could never run in the worker. MoveNet via TensorFlow.js runs natively
 * in Node on a pure-JS CPU backend — no native compilation, no headless browser.
 *
 * The 16 extra MediaPipe points were face and hand detail that none of the
 * derived metrics used; every landmark the metrics need is present here.
 */
export const POSE_LANDMARK_NAMES = [
  "nose",
  "left_eye", "right_eye",
  "left_ear", "right_ear",
  "left_shoulder", "right_shoulder",
  "left_elbow", "right_elbow",
  "left_wrist", "right_wrist",
  "left_hip", "right_hip",
  "left_knee", "right_knee",
  "left_ankle", "right_ankle",
] as const;

const LANDMARK_INDEX = Object.fromEntries(
  POSE_LANDMARK_NAMES.map((name, i) => [name, i]),
) as Record<(typeof POSE_LANDMARK_NAMES)[number], number>;

/** Below this keypoint confidence, treat the landmark as unobserved. */
const MIN_KEYPOINT_SCORE = 0.3;

/** Below this mean confidence, treat the whole frame as having no usable pose. */
const MIN_POSE_SCORE = 0.25;

type Detector = {
  estimatePoses: (input: unknown) => Promise<
    { keypoints: { x: number; y: number; score?: number; name?: string }[] }[]
  >;
};

/*
 * Specifiers held in variables so the bundler doesn't try to trace these into
 * the serverless function — they're loaded at runtime and declared in
 * next.config.ts as server-external packages.
 */
const TFJS_MODULE = "@tensorflow/tfjs";
const POSE_MODULE = "@tensorflow-models/pose-detection";
const CANVAS_MODULE = "@napi-rs/canvas";

let detectorPromise: Promise<Detector | null> | null = null;

/**
 * Loads MoveNet once per process.
 *
 * Weights are fetched over the network on first use (~10 MB, then cached in
 * memory for the process lifetime), so the first frame of the first job in a
 * cold worker pays a few seconds that later frames don't. Set
 * MOVENET_MODEL_URL to serve them from your own origin if that matters.
 *
 * Returns null on any failure and lets the caller fall back to null landmarks,
 * so a pose outage degrades the analysis rather than failing the job.
 */
async function loadDetector(): Promise<Detector | null> {
  detectorPromise ??= (async () => {
    try {
      const tf = await import(
        /* webpackIgnore: true */ /* turbopackIgnore: true */ TFJS_MODULE
      );
      const poseDetection = await import(
        /* webpackIgnore: true */ /* turbopackIgnore: true */ POSE_MODULE
      );

      // WebGL doesn't exist under Node; CPU is the only registered backend.
      await tf.setBackend("cpu");
      await tf.ready();

      return (await poseDetection.createDetector(
        poseDetection.SupportedModels.MoveNet,
        {
          // Thunder is slower than Lightning but noticeably better on the
          // partially-occluded, motion-blurred frames sparring footage produces.
          modelType: poseDetection.movenet.modelType.SINGLEPOSE_THUNDER,
          ...(process.env.MOVENET_MODEL_URL
            ? { modelUrl: process.env.MOVENET_MODEL_URL }
            : {}),
        },
      )) as unknown as Detector;
    } catch (error) {
      console.warn(
        "[pipeline] MoveNet unavailable — using null landmarks. " +
          `Install @tensorflow/tfjs and @tensorflow-models/pose-detection. (${String(error)})`,
      );
      return null;
    }
  })();

  return detectorPromise;
}

/**
 * Decodes a JPEG into the int32 [height, width, 3] tensor MoveNet expects.
 *
 * The caller owns the returned tensor and must dispose it — tfjs allocations
 * are not garbage collected, so a missed dispose in a per-frame loop leaks
 * until the process dies.
 */
async function decodeToTensor(
  path: string,
): Promise<{ tensor: unknown; width: number; height: number } | null> {
  try {
    const tf = await import(
      /* webpackIgnore: true */ /* turbopackIgnore: true */ TFJS_MODULE
    );
    const canvas = await import(
      /* webpackIgnore: true */ /* turbopackIgnore: true */ CANVAS_MODULE
    );

    const image = await canvas.loadImage(path);
    const surface = canvas.createCanvas(image.width, image.height);
    const ctx = surface.getContext("2d");
    ctx.drawImage(image, 0, 0);

    const { data, width, height } = ctx.getImageData(
      0, 0, image.width, image.height,
    );

    // Drop the alpha channel: RGBA -> RGB.
    const rgb = new Uint8Array(width * height * 3);
    for (let src = 0, dst = 0; src < data.length; src += 4, dst += 3) {
      rgb[dst] = data[src];
      rgb[dst + 1] = data[src + 1];
      rgb[dst + 2] = data[src + 2];
    }

    return { tensor: tf.tensor3d(rgb, [height, width, 3], "int32"), width, height };
  } catch (error) {
    console.warn(`[pipeline] Could not decode ${path}:`, error);
    return null;
  }
}

/**
 * Runs pose estimation over every extracted frame.
 *
 * A frame with no detected pose yields `landmarks: null` rather than being
 * dropped — "the athlete left the frame" is itself information the analysis
 * stage uses, and dropping frames would silently distort the timeline.
 */
export async function estimatePoses(
  frames: ExtractedFrame[],
): Promise<FramePose[]> {
  const detector = await loadDetector();
  const results: FramePose[] = [];

  for (const frame of frames) {
    if (!detector) {
      results.push({ frameIndex: frame.frameIndex, landmarks: null, score: null });
      continue;
    }

    const decoded = await decodeToTensor(frame.path);
    if (!decoded) {
      results.push({ frameIndex: frame.frameIndex, landmarks: null, score: null });
      continue;
    }

    // MoveNet allocates intermediate tensors internally that it does not free.
    // A scope makes every allocation inside it disposable in one call —
    // without this the worker leaks ~9 tensors per frame for the life of the
    // process, which on a long queue is a genuine memory leak.
    const tf = await import(
      /* webpackIgnore: true */ /* turbopackIgnore: true */ TFJS_MODULE
    );
    tf.engine().startScope();

    try {
      const poses = await detector.estimatePoses(decoded.tensor);
      const keypoints = poses[0]?.keypoints;

      if (!keypoints || keypoints.length === 0) {
        results.push({ frameIndex: frame.frameIndex, landmarks: null, score: null });
        continue;
      }

      // Normalise BOTH axes by the same scalar. Dividing x by width and y by
      // height independently would squash one axis relative to the other on any
      // non-square frame, and every distance here is a hypot() — so on a 360x640
      // portrait clip that silently corrupts every ratio downstream.
      // Using max(w,h) keeps values in [0,1] and preserves aspect ratio.
      const scale = Math.max(decoded.width, decoded.height);
      const landmarks: PoseLandmark[] = keypoints.map((kp) => ({
        x: kp.x / scale,
        y: kp.y / scale,
        z: 0, // MoveNet is 2D; the field is kept for schema compatibility.
        visibility: kp.score ?? 0,
      }));

      const score =
        landmarks.reduce((sum, l) => sum + l.visibility, 0) / landmarks.length;

      results.push(
        score < MIN_POSE_SCORE
          ? { frameIndex: frame.frameIndex, landmarks: null, score }
          : { frameIndex: frame.frameIndex, landmarks, score },
      );
    } catch (error) {
      console.warn(
        `[pipeline] Pose estimation failed on frame ${frame.frameIndex}:`,
        error,
      );
      results.push({ frameIndex: frame.frameIndex, landmarks: null, score: null });
    } finally {
      // tfjs tensors are manually managed — without these the worker leaks a
      // full frame buffer plus MoveNet's internals on every frame.
      tf.engine().endScope();
      (decoded.tensor as { dispose: () => void }).dispose();
    }
  }

  return results;
}

/** Returns a landmark only when it was observed confidently enough to trust. */
function get(
  landmarks: PoseLandmark[],
  name: (typeof POSE_LANDMARK_NAMES)[number],
): PoseLandmark | null {
  const landmark = landmarks[LANDMARK_INDEX[name]];
  if (!landmark || landmark.visibility < MIN_KEYPOINT_SCORE) return null;
  return landmark;
}

function distance(a: PoseLandmark, b: PoseLandmark): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Wraps an angle in degrees into [-180, 180]. */
function normalizeDegrees(degrees: number): number {
  const wrapped = ((degrees % 360) + 540) % 360;
  return wrapped - 180;
}

/**
 * Derived measurements that turn raw keypoints into the handful of quantities a
 * coach actually reads. Sending these alongside the images gives the model a
 * numeric backbone instead of asking it to eyeball everything.
 *
 * All values are ratios normalised against shoulder width, so they're
 * comparable across camera distances.
 */
export interface PoseMetrics {
  /** Ankle separation ÷ shoulder width. ~1.0 is a balanced boxing stance. */
  stanceWidthRatio: number | null;
  /** Vertical wrist position relative to the shoulder-to-eye span. 1.0 = eye level. */
  guardHeightRatio: number | null;
  /** Signed lead-foot offset. Sign is relative to the camera, not the athlete. */
  leadFootOffset: number | null;
  /** Hip-to-shoulder rotation difference, a proxy for torso torque. */
  torsoRotation: number | null;
}

export function computePoseMetrics(landmarks: PoseLandmark[]): PoseMetrics {
  const leftShoulder = get(landmarks, "left_shoulder");
  const rightShoulder = get(landmarks, "right_shoulder");
  const leftAnkle = get(landmarks, "left_ankle");
  const rightAnkle = get(landmarks, "right_ankle");
  const leftWrist = get(landmarks, "left_wrist");
  const rightWrist = get(landmarks, "right_wrist");
  const leftHip = get(landmarks, "left_hip");
  const rightHip = get(landmarks, "right_hip");
  const nose = get(landmarks, "nose");

  const shoulderWidth =
    leftShoulder && rightShoulder ? distance(leftShoulder, rightShoulder) : null;

  // Every ratio divides by shoulder width; a near-zero value means the athlete
  // is face-on at extreme distance and the ratios would be meaningless.
  const usableWidth = shoulderWidth && shoulderWidth > 0.01 ? shoulderWidth : null;

  const stanceWidthRatio =
    usableWidth && leftAnkle && rightAnkle
      ? distance(leftAnkle, rightAnkle) / usableWidth
      : null;

  let guardHeightRatio: number | null = null;
  if (usableWidth && nose && leftShoulder && rightShoulder && leftWrist && rightWrist) {
    const shoulderY = (leftShoulder.y + rightShoulder.y) / 2;
    const headSpan = shoulderY - nose.y;
    if (headSpan > 0.01) {
      const wristY = (leftWrist.y + rightWrist.y) / 2;
      // y grows downward, so subtracting from shoulderY makes higher = larger.
      guardHeightRatio = (shoulderY - wristY) / headSpan;
    }
  }

  const leadFootOffset =
    usableWidth && leftAnkle && rightAnkle
      ? (leftAnkle.x - rightAnkle.x) / usableWidth
      : null;

  let torsoRotation: number | null = null;
  if (leftShoulder && rightShoulder && leftHip && rightHip) {
    const shoulderAngle = Math.atan2(
      rightShoulder.y - leftShoulder.y,
      rightShoulder.x - leftShoulder.x,
    );
    const hipAngle = Math.atan2(rightHip.y - leftHip.y, rightHip.x - leftHip.x);
    // Wrap into [-180, 180]. Raw subtraction of two atan2 results spans
    // [-360, 360], which reports a 4° counter-rotation as 356° — a huge
    // apparent torque where there is almost none.
    torsoRotation = normalizeDegrees(
      ((shoulderAngle - hipAngle) * 180) / Math.PI,
    );
  }

  return { stanceWidthRatio, guardHeightRatio, leadFootOffset, torsoRotation };
}

function fmt(value: number | null, digits = 2): string {
  return value === null ? "n/a" : value.toFixed(digits);
}

/**
 * Renders per-frame metrics as a compact table for the model prompt.
 *
 * A table beats raw keypoint JSON here: 17 coordinates × 20 frames is thousands
 * of tokens of noise, while these four derived ratios are what the analysis
 * actually turns on.
 */
export function formatPoseTable(
  frames: ExtractedFrame[],
  poses: FramePose[],
): string {
  const byIndex = new Map(poses.map((p) => [p.frameIndex, p]));
  const rows = frames.map((frame) => {
    const pose = byIndex.get(frame.frameIndex);
    const t = frame.timestampSeconds.toFixed(1);

    if (!pose?.landmarks) {
      return `| ${frame.frameIndex} | ${t}s | no pose detected | | | |`;
    }

    const m = computePoseMetrics(pose.landmarks);
    return (
      `| ${frame.frameIndex} | ${t}s | ${fmt(m.stanceWidthRatio)} | ` +
      `${fmt(m.guardHeightRatio)} | ${fmt(m.leadFootOffset)} | ` +
      `${fmt(m.torsoRotation, 1)}° |`
    );
  });

  return [
    "| frame | time | stance width | guard height | lead foot offset | torso rotation |",
    "|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}
