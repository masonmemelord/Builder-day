import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { drainQueue } from "@/lib/pipeline/worker";

/**
 * Node runtime, not edge — this route's call graph shells out to ffmpeg and
 * yt-dlp, which are real binaries and cannot run on an edge runtime.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Constant-time secret comparison. A plain `===` leaks the secret's length and
 * a prefix oracle through response timing.
 */
function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function authorize(request: Request): boolean {
  const expected = process.env.WORKER_SECRET;
  if (!expected) return false;

  const header = request.headers.get("authorization");
  if (header?.startsWith("Bearer ")) {
    return secretMatches(header.slice(7), expected);
  }

  // Vercel Cron sends this header instead of a custom Authorization value.
  const cronSecret = request.headers.get("x-vercel-cron-secret");
  if (cronSecret) return secretMatches(cronSecret, expected);

  return false;
}

async function handle(request: Request) {
  if (!authorize(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const supabase = createAdminClient();

  try {
    // Budget stops short of maxDuration so the last job finishes and writes its
    // terminal status instead of being killed mid-write and left leased.
    const results = await drainQueue(supabase, { maxJobs: 3, budgetMs: 240_000 });

    return NextResponse.json({
      processed: results.length,
      results,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[worker] Drain failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export const POST = handle;

/** Vercel Cron issues GET requests. */
export const GET = handle;
