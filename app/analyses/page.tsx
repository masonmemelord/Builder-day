import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { JOB_STAGE_LABELS, isJobActive, type JobStatus } from "@/lib/types";

export const metadata: Metadata = { title: "My clips — Fight IQ" };

// Job status changes out of band, so this list must never be cached.
export const dynamic = "force-dynamic";

interface ClipRow {
  id: string;
  title: string;
  source: "upload" | "youtube";
  created_at: string;
  analyses: { id: string; summary: string }[];
  analysis_jobs: { status: JobStatus; error: string | null }[];
}

function StatusPill({ clip }: { clip: ClipRow }) {
  const hasAnalysis = clip.analyses.length > 0;
  // Jobs are ordered newest-first by the query below.
  const job = clip.analysis_jobs[0];

  if (hasAnalysis) {
    return (
      <span className="rounded-full border border-success/40 px-2.5 py-0.5 text-xs text-success">
        Ready
      </span>
    );
  }
  if (job && isJobActive(job.status)) {
    return (
      <span className="rounded-full border border-signal/40 px-2.5 py-0.5 text-xs text-signal">
        {JOB_STAGE_LABELS[job.status]}
      </span>
    );
  }
  if (job?.status === "failed") {
    return (
      <span className="rounded-full border border-accent/40 px-2.5 py-0.5 text-xs text-accent">
        Failed
      </span>
    );
  }
  return (
    <span className="rounded-full border border-border px-2.5 py-0.5 text-xs text-muted">
      No analysis
    </span>
  );
}

export default async function AnalysesPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login?next=/analyses");

  const { data, error } = await supabase
    .from("videos")
    .select(
      `id, title, source, created_at,
       analyses ( id, summary ),
       analysis_jobs ( status, error )`,
    )
    .order("created_at", { ascending: false })
    .order("created_at", { referencedTable: "analysis_jobs", ascending: false })
    .limit(50);

  const clips = (data ?? []) as unknown as ClipRow[];

  return (
    <div className="mx-auto max-w-3xl px-6 py-14">
      <header className="mb-10 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-[0.18em] text-accent">
            Library
          </p>
          <h1 className="display text-4xl leading-tight">My clips</h1>
        </div>
        <Link
          href="/upload"
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
        >
          New analysis
        </Link>
      </header>

      {error ? (
        <p
          role="alert"
          className="rounded-md border border-accent/40 bg-accent-soft px-4 py-3 text-sm"
        >
          Could not load your clips: {error.message}
        </p>
      ) : clips.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-12 text-center">
          <p className="mb-1 text-foreground">No clips yet.</p>
          <p className="mb-6 text-sm text-muted">
            Upload sparring footage or paste a YouTube link to get started.
          </p>
          <Link
            href="/upload"
            className="inline-block rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
          >
            Analyze your first clip
          </Link>
        </div>
      ) : (
        <ul className="space-y-3">
          {clips.map((clip) => {
            const analysis = clip.analyses[0];
            return (
              <li key={clip.id}>
                <Link
                  href={`/analyses/${clip.id}`}
                  className="block rounded-lg border border-border bg-surface p-5 transition-colors hover:border-accent/50"
                >
                  <div className="mb-2 flex flex-wrap items-center gap-3">
                    <h2 className="font-medium text-foreground">{clip.title}</h2>
                    <StatusPill clip={clip} />
                  </div>
                  {analysis ? (
                    <p className="mb-2 line-clamp-2 text-sm leading-relaxed text-muted">
                      {analysis.summary}
                    </p>
                  ) : null}
                  <p className="text-xs text-muted">
                    {clip.source === "youtube" ? "YouTube" : "Upload"} ·{" "}
                    {new Date(clip.created_at).toLocaleString()}
                  </p>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
