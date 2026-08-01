import "server-only";

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { config } from "@/lib/env";
import type { AnalysisJob, JobStatus, Video } from "@/lib/types";
import { analyzeFootage, RefusalError } from "./analyze";
import { MissingBinaryError } from "./binaries";
import { extractFrames, sampleFrames } from "./frames";
import { ingest } from "./ingest";
import { estimatePoses } from "./pose";

const WORKER_ID = `worker-${randomUUID().slice(0, 8)}`;

/** Lease duration. Must exceed the route's maxDuration or jobs get double-claimed. */
const LEASE_SECONDS = 900;

export interface ProcessResult {
  claimed: boolean;
  jobId?: string;
  videoId?: string;
  status?: JobStatus;
  error?: string;
}

async function setStage(
  supabase: SupabaseClient,
  jobId: string,
  status: JobStatus,
  progress: number,
  detail: string,
): Promise<void> {
  const { error } = await supabase
    .from("analysis_jobs")
    .update({ status, progress, stage_detail: detail })
    .eq("id", jobId);

  if (error) {
    // A failed progress write shouldn't kill an otherwise healthy job — the
    // UI just shows a stale stage until the next update lands.
    console.warn(`[worker] Failed to update stage for job ${jobId}:`, error.message);
  }
}

/**
 * Claims and processes exactly one queued job.
 *
 * Returns `{ claimed: false }` when the queue is empty, which lets the caller
 * distinguish "nothing to do" from "did work" without treating an idle poll as
 * an error.
 */
export async function processNextJob(
  supabase: SupabaseClient,
): Promise<ProcessResult> {
  const { data: claimed, error: claimError } = await supabase
    .rpc("claim_next_job", {
      p_worker_id: WORKER_ID,
      p_lease_seconds: LEASE_SECONDS,
    })
    .maybeSingle<AnalysisJob>();

  if (claimError) {
    throw new Error(`Failed to claim a job: ${claimError.message}`);
  }
  if (!claimed) {
    return { claimed: false };
  }

  const job = claimed;

  try {
    const status = await runJob(supabase, job);
    return { claimed: true, jobId: job.id, videoId: job.video_id, status };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = await failJob(supabase, job, message, error);
    return {
      claimed: true,
      jobId: job.id,
      videoId: job.video_id,
      status,
      error: message,
    };
  }
}

async function runJob(
  supabase: SupabaseClient,
  job: AnalysisJob,
): Promise<JobStatus> {
  const { data: video, error: videoError } = await supabase
    .from("videos")
    .select("*")
    .eq("id", job.video_id)
    .single<Video>();

  if (videoError || !video) {
    throw new Error(
      `Video ${job.video_id} not found: ${videoError?.message ?? "no row"}`,
    );
  }

  // Idempotency guard. A job can legitimately be re-claimed after a lease
  // expiry (a Vercel timeout mid-analysis), and reprocessing a clip that
  // already has an analysis burns tokens for a result we already hold.
  const { data: existing } = await supabase
    .from("analyses")
    .select("id")
    .eq("video_id", video.id)
    .maybeSingle();

  if (existing) {
    await supabase
      .from("analysis_jobs")
      .update({
        status: "succeeded",
        progress: 100,
        stage_detail: "Analysis already existed",
        finished_at: new Date().toISOString(),
        locked_at: null,
        locked_by: null,
      })
      .eq("id", job.id);
    return "succeeded";
  }

  // --- 1. Ingest ------------------------------------------------------------
  await setStage(
    supabase,
    job.id,
    "fetching",
    10,
    video.source === "youtube" ? "Downloading from YouTube" : "Loading upload",
  );

  const local = await ingest(supabase, video);

  try {
    // --- 2. Frame extraction ------------------------------------------------
    await setStage(supabase, job.id, "extracting", 30, "Extracting frames");

    const allFrames = await extractFrames(supabase, {
      videoPath: local.path,
      videoId: video.id,
      userId: video.user_id,
      durationSeconds: local.durationSeconds,
    });

    const frames = sampleFrames(allFrames, config.maxFramesPerAnalysis);

    // --- 3. Pose estimation -------------------------------------------------
    await setStage(
      supabase,
      job.id,
      "posing",
      55,
      `Estimating pose across ${frames.length} frames`,
    );

    const poses = await estimatePoses(frames);

    // Persist frames + landmarks. Chunked because a long clip can produce
    // hundreds of rows and a single oversized insert will be rejected.
    const poseByIndex = new Map(poses.map((p) => [p.frameIndex, p]));
    const frameRows = frames.map((frame) => {
      const pose = poseByIndex.get(frame.frameIndex);
      return {
        video_id: video.id,
        user_id: video.user_id,
        frame_index: frame.frameIndex,
        timestamp_seconds: frame.timestampSeconds,
        storage_path: frame.storagePath,
        width: frame.width,
        height: frame.height,
        landmarks: pose?.landmarks ?? null,
        pose_score: pose?.score ?? null,
      };
    });

    for (let i = 0; i < frameRows.length; i += 100) {
      const { error } = await supabase
        .from("video_frames")
        .upsert(frameRows.slice(i, i + 100), {
          onConflict: "video_id,frame_index",
        });
      if (error) {
        throw new Error(`Failed to persist frames: ${error.message}`);
      }
    }

    // --- 4. Vision analysis -------------------------------------------------
    await setStage(supabase, job.id, "analyzing", 70, "Analyzing footage");

    const { payload, model, framesAnalyzed } = await analyzeFootage({
      frames,
      poses,
      clipDurationSeconds: local.durationSeconds,
      userNotes: video.notes,
    });

    // --- 5. Store the result ------------------------------------------------
    const { error: insertError } = await supabase.from("analyses").insert({
      video_id: video.id,
      user_id: video.user_id,
      model,
      frames_analyzed: framesAnalyzed,
      summary: payload.summary,
      stance: payload.stance,
      guard: payload.guard,
      footwork: payload.footwork,
      output_rate: payload.output_rate,
      pro_comparison: payload.pro_comparison,
      technical_gaps: payload.technical_gaps,
      drills: payload.drills,
      raw: payload,
    });

    if (insertError) {
      throw new Error(`Failed to store analysis: ${insertError.message}`);
    }

    await supabase
      .from("analysis_jobs")
      .update({
        status: "succeeded",
        progress: 100,
        stage_detail: "Complete",
        finished_at: new Date().toISOString(),
        locked_at: null,
        locked_by: null,
        error: null,
      })
      .eq("id", job.id);

    return "succeeded";
  } finally {
    await local.cleanup();
  }
}

/**
 * Marks a job failed, or re-queues it with backoff when retries remain.
 *
 * Refusals and missing binaries are terminal — retrying either produces the
 * same outcome and just burns the remaining attempts.
 */
async function failJob(
  supabase: SupabaseClient,
  job: AnalysisJob,
  message: string,
  error: unknown,
): Promise<JobStatus> {
  const terminal =
    error instanceof RefusalError || error instanceof MissingBinaryError;
  const attemptsUsed = job.attempts; // already incremented by claim_next_job
  const shouldRetry = !terminal && attemptsUsed < job.max_attempts;

  if (shouldRetry) {
    const backoffSeconds = 30 * 2 ** (attemptsUsed - 1);
    await supabase
      .from("analysis_jobs")
      .update({
        status: "queued",
        stage_detail: `Retrying after error (attempt ${attemptsUsed} of ${job.max_attempts})`,
        error: message,
        locked_at: null,
        locked_by: null,
        run_after: new Date(Date.now() + backoffSeconds * 1000).toISOString(),
      })
      .eq("id", job.id);

    console.warn(
      `[worker] Job ${job.id} failed (attempt ${attemptsUsed}), retrying in ${backoffSeconds}s: ${message}`,
    );
    return "queued";
  }

  await supabase
    .from("analysis_jobs")
    .update({
      status: "failed",
      stage_detail: null,
      error: message,
      finished_at: new Date().toISOString(),
      locked_at: null,
      locked_by: null,
    })
    .eq("id", job.id);

  console.error(`[worker] Job ${job.id} failed permanently: ${message}`);
  return "failed";
}

/**
 * Drains up to `maxJobs`, stopping early when the queue empties or the time
 * budget is nearly spent. The budget check happens before claiming a new job
 * so we never start work we can't finish inside the function's lifetime.
 */
export async function drainQueue(
  supabase: SupabaseClient,
  options: { maxJobs?: number; budgetMs?: number } = {},
): Promise<ProcessResult[]> {
  const { maxJobs = 3, budgetMs = 4 * 60_000 } = options;
  const deadline = Date.now() + budgetMs;
  const results: ProcessResult[] = [];

  for (let i = 0; i < maxJobs; i += 1) {
    if (Date.now() > deadline) break;

    const result = await processNextJob(supabase);
    if (!result.claimed) break;
    results.push(result);
  }

  return results;
}
