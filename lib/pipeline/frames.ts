import "server-only";

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BUCKETS, config } from "@/lib/env";
import type { SupabaseClient } from "@supabase/supabase-js";
import { FFMPEG_PATH, requireBinary, run } from "./binaries";
import { makeScratchDir } from "./ingest";

export interface ExtractedFrame {
  frameIndex: number;
  timestampSeconds: number;
  /** Absolute local path to the JPEG. */
  path: string;
  storagePath: string;
  width: number | null;
  height: number | null;
}

const FRAME_WIDTH = 720;

/**
 * Extracts frames at `config.framesPerSecond` and uploads each to the `frames`
 * bucket.
 *
 * Frames are scaled to 720px wide. At `detail: "high"` the vision API tiles an
 * image this size into roughly 1.1k tokens; a larger source costs
 * proportionally more without making stance, guard, or foot placement any more
 * legible. Across 20 frames that difference dominates the cost of a job.
 */
export async function extractFrames(
  supabase: SupabaseClient,
  args: {
    videoPath: string;
    videoId: string;
    userId: string;
    durationSeconds: number | null;
  },
): Promise<ExtractedFrame[]> {
  const { videoPath, videoId, userId, durationSeconds } = args;

  const dir = await makeScratchDir("frames");
  const pattern = join(dir, "frame-%05d.jpg");

  const usable = await requireBinary(
    FFMPEG_PATH,
    "Install with `brew install ffmpeg` or `apt-get install ffmpeg`.",
  );

  if (usable) {
    await run(
      FFMPEG_PATH,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        videoPath,
        "-vf",
        `fps=${config.framesPerSecond},scale=${FRAME_WIDTH}:-2`,
        "-q:v",
        "3",
        pattern,
      ],
      { timeoutMs: 10 * 60_000 },
    );
  } else {
    // Stub: emit a single 1x1 JPEG so downstream stages have something real to
    // read, upload, and count without pretending analysis happened.
    await writeFile(join(dir, "frame-00001.jpg"), STUB_JPEG);
  }

  const files = (await readdir(dir))
    .filter((f) => f.startsWith("frame-") && f.endsWith(".jpg"))
    .sort();

  if (files.length === 0) {
    throw new Error(
      "ffmpeg produced no frames. The source file is likely empty or not a video.",
    );
  }

  const frames: ExtractedFrame[] = [];

  for (const [i, file] of files.entries()) {
    const localPath = join(dir, file);
    const bytes = await readFile(localPath);
    const storagePath = `${userId}/${videoId}/${file}`;

    const { error } = await supabase.storage
      .from(BUCKETS.frames)
      .upload(storagePath, bytes, { contentType: "image/jpeg", upsert: true });

    if (error) {
      throw new Error(`Failed to upload frame ${file}: ${error.message}`);
    }

    frames.push({
      frameIndex: i,
      timestampSeconds: i / config.framesPerSecond,
      path: localPath,
      storagePath,
      width: usable ? FRAME_WIDTH : null,
      height: null,
    });
  }

  // Guard against ffmpeg over-producing on a variable-framerate source.
  if (durationSeconds !== null) {
    const expected = Math.ceil(durationSeconds * config.framesPerSecond) + 2;
    if (frames.length > expected) {
      console.warn(
        `[pipeline] ${frames.length} frames from a ${durationSeconds}s clip — ` +
          `expected ~${expected}. Source is probably variable-framerate.`,
      );
    }
  }

  return frames;
}

/**
 * Evenly samples down to `maxFrames`, always keeping the first and last frame.
 *
 * Even sampling matters more than picking "interesting" frames here: output
 * rate and footwork are judged from how the athlete changes across the clip,
 * so a biased sample skews the read.
 */
export function sampleFrames<T>(frames: T[], maxFrames: number): T[] {
  if (frames.length <= maxFrames) return frames;
  if (maxFrames <= 1) return frames.slice(0, Math.max(maxFrames, 0));

  const step = (frames.length - 1) / (maxFrames - 1);
  const picked: T[] = [];
  for (let i = 0; i < maxFrames; i += 1) {
    picked.push(frames[Math.round(i * step)]);
  }
  return picked;
}

/** Smallest valid JPEG (1x1 black). Used only by the no-ffmpeg stub path. */
const STUB_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
    "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
    "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64",
);
