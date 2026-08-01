import "server-only";

import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { BUCKETS, config } from "@/lib/env";
import type { Video } from "@/lib/types";
import { requireBinary, run, YT_DLP_PATH, FFPROBE_PATH } from "./binaries";

export interface LocalVideo {
  /** Absolute path to the video on local disk. */
  path: string;
  durationSeconds: number | null;
  sizeBytes: number;
  /** Call when done — removes the whole scratch directory. */
  cleanup: () => Promise<void>;
}

export async function makeScratchDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `fightiq-${prefix}-`));
}

/** Reads duration via ffprobe. Returns null when ffprobe is unavailable. */
export async function probeDuration(path: string): Promise<number | null> {
  if (!(await requireBinary(FFPROBE_PATH, "Install ffmpeg (bundles ffprobe)."))) {
    return null;
  }

  try {
    const stdout = await run(
      FFPROBE_PATH,
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        path,
      ],
      { timeoutMs: 30_000 },
    );
    const seconds = Number.parseFloat(stdout.trim());
    return Number.isFinite(seconds) ? seconds : null;
  } catch (error) {
    console.warn("[pipeline] ffprobe failed:", error);
    return null;
  }
}

/**
 * Path 1 — direct upload. The file is already in Supabase Storage (the browser
 * uploaded it straight there), so this just pulls it down for processing.
 */
export async function fetchStoredVideo(
  supabase: SupabaseClient,
  video: Video,
): Promise<LocalVideo> {
  if (!video.storage_path) {
    throw new Error(`Video ${video.id} has no storage_path to fetch.`);
  }

  const dir = await makeScratchDir("upload");
  const cleanup = () => rm(dir, { recursive: true, force: true });

  try {
    const { data, error } = await supabase.storage
      .from(BUCKETS.footage)
      .download(video.storage_path);

    if (error || !data) {
      throw new Error(
        `Failed to download ${video.storage_path}: ${error?.message ?? "no data"}`,
      );
    }

    const path = join(dir, "source.mp4");
    await writeFile(path, Buffer.from(await data.arrayBuffer()));
    const { size } = await stat(path);

    return {
      path,
      sizeBytes: size,
      durationSeconds: await probeDuration(path),
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/**
 * Path 2 — YouTube URL. Downloads via yt-dlp, honouring the optional clip
 * window, then uploads the result into the same bucket and path layout an
 * upload would have used. From the caller's perspective the two paths converge
 * here: after this returns, `video.storage_path` is set either way.
 */
export async function fetchYouTubeVideo(
  supabase: SupabaseClient,
  video: Video,
): Promise<LocalVideo> {
  if (!video.source_url) {
    throw new Error(`Video ${video.id} has no source_url to fetch.`);
  }

  const dir = await makeScratchDir("youtube");
  const cleanup = () => rm(dir, { recursive: true, force: true });
  const path = join(dir, "source.mp4");

  try {
    const usable = await requireBinary(
      YT_DLP_PATH,
      "Install with `pip install -U yt-dlp` or `brew install yt-dlp`.",
    );

    if (usable) {
      const args = [
        video.source_url,
        // Prefer a single pre-muxed mp4 so we never need a merge step.
        "-f",
        "best[ext=mp4][height<=720]/best[height<=720]/best",
        "-o",
        path,
        "--no-playlist",
        "--no-warnings",
        "--no-progress",
        // Never let a malicious URL make yt-dlp write outside the scratch dir.
        "--restrict-filenames",
      ];

      const { clip_start_seconds: start, clip_end_seconds: end } = video;
      if (start !== null || end !== null) {
        // yt-dlp's own section download is far cheaper than fetching the whole
        // video and trimming afterwards.
        args.push(
          "--download-sections",
          `*${start ?? 0}-${end ?? "inf"}`,
          "--force-keyframes-at-cuts",
        );
      }

      await run(YT_DLP_PATH, args, { timeoutMs: 10 * 60_000 });
    } else {
      // Stub: a zero-byte placeholder keeps the pipeline shape intact so the
      // remaining stages still run and the job reaches a terminal state.
      await writeFile(path, Buffer.alloc(0));
    }

    const { size } = await stat(path);
    const durationSeconds = await probeDuration(path);

    // Upload into the identical layout an upload would use.
    const storagePath = `${video.user_id}/${video.id}/source.mp4`;
    const { error: uploadError } = await supabase.storage
      .from(BUCKETS.footage)
      .upload(storagePath, await readFile(path), {
        contentType: "video/mp4",
        upsert: true,
      });

    if (uploadError) {
      throw new Error(`Failed to store fetched video: ${uploadError.message}`);
    }

    await supabase
      .from("videos")
      .update({
        storage_path: storagePath,
        duration_seconds: durationSeconds,
        size_bytes: size,
      })
      .eq("id", video.id);

    return { path, sizeBytes: size, durationSeconds, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/** Dispatches to the right ingestion path. Both converge on a LocalVideo. */
export async function ingest(
  supabase: SupabaseClient,
  video: Video,
): Promise<LocalVideo> {
  const local =
    video.source === "youtube"
      ? await fetchYouTubeVideo(supabase, video)
      : await fetchStoredVideo(supabase, video);

  if (
    local.durationSeconds !== null &&
    local.durationSeconds > config.maxClipSeconds
  ) {
    await local.cleanup();
    throw new Error(
      `Clip is ${Math.round(local.durationSeconds)}s, which exceeds the ` +
        `${config.maxClipSeconds}s limit for this demo. Trim it and try again.`,
    );
  }

  return local;
}
