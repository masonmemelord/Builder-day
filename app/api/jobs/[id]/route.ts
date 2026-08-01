import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isJobActive, type AnalysisJob } from "@/lib/types";

export const runtime = "nodejs";

/** Job status, polled by the upload page while processing runs. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  // RLS already scopes this to the caller; the explicit user_id filter makes a
  // missing row a 404 rather than an empty 200.
  const { data: job, error } = await supabase
    .from("analysis_jobs")
    .select("*")
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle<AnalysisJob>();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!job) {
    return NextResponse.json({ error: "Job not found." }, { status: 404 });
  }

  return NextResponse.json(
    {
      id: job.id,
      videoId: job.video_id,
      status: job.status,
      stageDetail: job.stage_detail,
      progress: job.progress,
      error: job.error,
      active: isJobActive(job.status),
      attempts: job.attempts,
      maxAttempts: job.max_attempts,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
