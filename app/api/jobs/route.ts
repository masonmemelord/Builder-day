import { NextResponse } from "next/server";
import { z } from "zod";
import { config } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import type { AnalysisJob, Video } from "@/lib/types";

export const runtime = "nodejs";

/**
 * Accepts a URL only if it is a real YouTube watch/short link.
 *
 * This is an allowlist, not a blocklist: the URL is handed to yt-dlp, so
 * anything that isn't explicitly YouTube shouldn't reach it.
 */
const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be",
  "www.youtu.be",
]);

const youtubeUrl = z
  .string()
  .url()
  .refine((value) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return false;
    }
    return parsed.protocol === "https:" && YOUTUBE_HOSTS.has(parsed.hostname);
  }, "Must be an https YouTube URL.");

const createJobSchema = z
  .discriminatedUnion("source", [
    z.object({
      source: z.literal("upload"),
      storagePath: z.string().min(1),
      title: z.string().trim().min(1).max(200),
      notes: z.string().trim().max(2000).optional(),
      sizeBytes: z.number().int().positive().max(config.maxUploadBytes).optional(),
    }),
    z.object({
      source: z.literal("youtube"),
      sourceUrl: youtubeUrl,
      title: z.string().trim().min(1).max(200),
      notes: z.string().trim().max(2000).optional(),
      clipStartSeconds: z.number().int().min(0).optional(),
      clipEndSeconds: z.number().int().min(0).optional(),
    }),
  ])
  .refine(
    (value) =>
      value.source !== "youtube" ||
      value.clipStartSeconds === undefined ||
      value.clipEndSeconds === undefined ||
      value.clipEndSeconds > value.clipStartSeconds,
    { message: "Clip end must be after clip start." },
  )
  .refine(
    (value) =>
      value.source !== "youtube" ||
      value.clipStartSeconds === undefined ||
      value.clipEndSeconds === undefined ||
      value.clipEndSeconds - value.clipStartSeconds <= config.maxClipSeconds,
    { message: `Clip window cannot exceed ${config.maxClipSeconds} seconds.` },
  );

export async function POST(request: Request) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  // ToS acknowledgement is enforced here, not only in the UI — the modal is a
  // convenience, this is the actual gate.
  const { data: profile } = await supabase
    .from("profiles")
    .select("terms_accepted_at, terms_version")
    .eq("id", user.id)
    .maybeSingle();

  if (!profile?.terms_accepted_at || profile.terms_version !== config.termsVersion) {
    return NextResponse.json(
      {
        error: "You must accept the Terms of Service before uploading.",
        code: "TERMS_NOT_ACCEPTED",
      },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = createJobSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request.", issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const input = parsed.data;

  // For uploads, verify the claimed storage path is actually inside this
  // user's folder. Storage RLS already enforces this on write, but a forged
  // path here would otherwise create a video row pointing at someone else's
  // object.
  if (input.source === "upload" && !input.storagePath.startsWith(`${user.id}/`)) {
    return NextResponse.json(
      { error: "storagePath does not belong to the authenticated user." },
      { status: 403 },
    );
  }

  const { data: video, error: videoError } = await supabase
    .from("videos")
    .insert({
      user_id: user.id,
      source: input.source,
      title: input.title,
      notes: input.notes ?? null,
      storage_path: input.source === "upload" ? input.storagePath : null,
      source_url: input.source === "youtube" ? input.sourceUrl : null,
      clip_start_seconds:
        input.source === "youtube" ? (input.clipStartSeconds ?? null) : null,
      clip_end_seconds:
        input.source === "youtube" ? (input.clipEndSeconds ?? null) : null,
      size_bytes: input.source === "upload" ? (input.sizeBytes ?? null) : null,
    })
    .select()
    .single<Video>();

  if (videoError || !video) {
    return NextResponse.json(
      { error: `Could not create video: ${videoError?.message ?? "unknown"}` },
      { status: 500 },
    );
  }

  const { data: job, error: jobError } = await supabase
    .from("analysis_jobs")
    .insert({ video_id: video.id, user_id: user.id })
    .select()
    .single<AnalysisJob>();

  if (jobError || !job) {
    // Roll back the orphaned video so a retry doesn't accumulate dead rows.
    await supabase.from("videos").delete().eq("id", video.id);
    return NextResponse.json(
      { error: `Could not queue job: ${jobError?.message ?? "unknown"}` },
      { status: 500 },
    );
  }

  void kickWorker(request);

  return NextResponse.json({ videoId: video.id, jobId: job.id }, { status: 201 });
}

/**
 * Nudges the worker so a job starts immediately rather than waiting for the
 * next cron tick.
 *
 * Deliberately fire-and-forget: a failure here only delays processing until
 * the cron picks the job up, so it must never fail the user's request.
 */
async function kickWorker(request: Request): Promise<void> {
  const secret = process.env.WORKER_SECRET;
  if (!secret) return;

  try {
    const url = new URL("/api/worker/process", request.url);
    await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(1_000),
    });
  } catch {
    // Expected — we don't wait for the worker to finish.
  }
}
