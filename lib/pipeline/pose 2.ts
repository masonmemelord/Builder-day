import "server-only";

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PoseLandmark } from "@/lib/types";
import type { ExtractedFrame } from "./frames";

export interface FramePose {
  frameIndex: number;
  landmarks: PoseLandmark[] | null;
  score: number | null;
}

/**
 * MediaPipe's 33-point body topology, in landmark-array order. Used to turn
 * raw coordinates into something the model can reason about by name.
 */
export const POSE_LANDMARK_NAMES = [
  "nose",
  "left_eye_inner", "left_eye", "left_eye_outer",
  "right_eye_inner", "right_eye", "right_eye_outer",
  "left_ear", "right_ear",
  "mouth_left", "mouth_right",
  "left_shoulder", "right_shoulder",
  "left_elbow", "right_elbow",
  "left_wrist", "right_wrist",
  "left_pinky", "right_pinky",
  "left_index", "right_index",
  "left_thumb", "right_thumb",
  "left_hip", "right_hip",
  "left_knee", "right_knee",
  "left_ankle", "right_ankle",
  "left_heel", "right_heel",
  "left_foot_index", "right_foot_index",
] as const;

const LANDMARK_INDEX = Object.fromEntries(
  POSE_LANDMARK_NAMES.map((name, i) => [name, i]),
) as Record<(typeof POSE_LANDMARK_NAMES)[number], number>;

/**
 * Lazily loads MediaPipe. It is an optional dependency because the Node build
 * additionally needs a canvas implementation to decode JPEGs:
 *
 *   npm install @mediapipe/tasks-vision @napi-rs/canvas
 *
 * and the pose model file at MEDIAPIPE_POSE_MODEL (default
 * ./models/pose_landmarker_lite.task), downloadable from
 * https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker
 *
 * Returns null when either piece is absent, and the caller falls back to the
 * stub. The loader result is cached so we probe once per process.
 */
type Landmarker = {
  detect: (image: unknown) => { landmarks?: unknown[][] };
};

/*
 * Specifiers are held in variables so neither TypeScript nor the bundler tries
 * to resolve them statically — these are genuinely optional at build time, and
 * a literal import of an uninstalled package fails the build.
 */
const MEDIAPIPE_MODULE = "@mediapipe/tasks-vision";
const CANVAS_MODULE = "@napi-rs/canvas";

let landmarkerPromise: Promise<Landmarker | null> | null = null;

async function loadLandmarker(): Promise<Landmarker | null> {
  landmarkerPromise ??= (async () => {
    try {
      const vision = await import(
        /* webpackIgnore: true */ /* turbopackIgnore: true */ MEDIAPIPE_MODULE
      );

      // Resolved under a fixed `models/` subfolder so the bundler's dependency
      // tracer can scope it, rather than treating it as an arbitrary read.
      const modelFile =
        process.env.MEDIAPIPE_POSE_MODEL ?? "pose_landmarker_lite.task";
      const modelBuffer = await readFile(
        join(process.cwd(), "models", modelFile),
      );

      const fileset = await vision.FilesetResolver.forVisionTasks(
        "node_modules/@mediapipe/tasks-vision/wasm",
      );

      return (await vision.PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetBuffer: new Uint8Array(modelBuffer) },
        runningMode: "IMAGE",
        numPoses: 1,
      })) as unknown as Landmarker;
    } catch (error) {
      console.warn(
        "[pipeline] MediaPipe unavailable — using stub landmarks. " +
          "Install @mediapipe/tasks-vision + @napi-rs/canvas and provide a " +
          `pose model to enable real pose estimation. (${String(error)})`,
      );
      return null;
    }
  })();

  return landmarkerPromise;
}

async function decodeImage(path: string): Promise<unknown | null> {
  try {
    const canvas = await import(
      /* webpackIgnore: true */ /* turbopackIgnore: true */ CANVAS_MODULE
    );
    return await canvas.loadImage(path);
  } catch {
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
  const landmarker = await loadLandmarker();
  const results: FramePose[] = [];

  for (const frame of frames) {
    if (!landmarker) {
      results.push({ frameIndex: frame.frameIndex, landmarks: null, score: null });
      continue;
    }

    try {
      const image = await decodeImage(frame.path);
      if (!image) {
        results.push({ frameIndex: frame.frameIndex, landmarks: null, score: null });
        continue;
      }

      const detection = landmarker.detect(image);
      const raw = detection.landmarks?.[0];

      if (!raw || raw.length === 0) {
        results.push({ frameIndex: frame.frameIndex, landmarks: null, score: null });
        continue;
      }

      const landmarks: PoseLandmark[] = raw.map((point) => {
        const p = point as Partial<PoseLandmark>;
        return {
          x: p.x ?? 0,
          y: p.y ?? 0,
          z: p.z ?? 0,
          visibility: p.visibility ?? 0,
        };
      });

      const score =
        landmarks.reduce((sum, l) => sum + l.visibility, 0) / landmarks.length;

      results.push({ frameIndex: frame.frameIndex, landmarks, score });
    } catch (error) {
      console.warn(
        `[pipeline] Pose estimation failed on frame ${frame.frameIndex}:`,
        error,
      );
      results.push({ frameIndex: frame.frameIndex, landmarks: null, score: null });
    }
  }

  return results;
}

function get(
  landmarks: PoseLandmark[],
  name: (typeof POSE_LANDMARK_NAMES)[number],
): PoseLandmark | null {
  return landmarks[LANDMARK_INDEX[name]] ?? null;
}

function distance(a: PoseLandmark, b: PoseLandmark): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Derived measurements that turn 33 raw coordinates into the handful of
 * quantities a coach actually reads. Sending these alongside the images gives
 * the model a numeric backbone instead of asking it to eyeball everything.
 *
 * All values are ratios normalised against shoulder width, so they're
 * comparable across camera distances.
 */
export interface PoseMetrics {
  /** Ankle separation ÷ shoulder width. ~1.0 is a balanced boxing stance. */
  stanceWidthRatio: number | null;
  /** Vertical wrist position relative to the shoulder-to-eye span. 1.0 = eye level. */
  guardHeightRatio: number | null;
  /** Signed lead-foot offset. Negative = left foot forward (orthodox from camera-left). */
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
  // is face-on to the camera at extreme distance and the ratios are meaningless.
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
    torsoRotation = ((shoulderAngle - hipAngle) * 180) / Math.PI;
  }

  return { stanceWidthRatio, guardHeightRatio, leadFootOffset, torsoRotation };
}

function fmt(value: number | null, digits = 2): string {
  return value === null ? "n/a" : value.toFixed(digits);
}

/**
 * Renders per-frame metrics as a compact table for the model prompt.
 *
 * A table beats raw landmark JSON here: 33 coordinates × 20 frames is ~15k
 * tokens of noise, while these four derived ratios are what the analysis
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
