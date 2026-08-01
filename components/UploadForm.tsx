"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { TermsGate } from "@/components/TermsGate";
import { createClient } from "@/lib/supabase/client";
import { JOB_STAGE_LABELS, type JobStatus } from "@/lib/types";

type Tab = "upload" | "youtube";

interface JobState {
  id: string;
  videoId: string;
  status: JobStatus;
  stageDetail: string | null;
  progress: number;
  error: string | null;
  active: boolean;
}

const ACCEPTED_TYPES = [
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-matroska",
];

export function UploadForm({
  userId,
  termsAccepted,
  maxUploadBytes,
  maxClipSeconds,
}: {
  userId: string;
  termsAccepted: boolean;
  maxUploadBytes: number;
  maxClipSeconds: number;
}) {
  const router = useRouter();
  const [accepted, setAccepted] = useState(termsAccepted);
  const [tab, setTab] = useState<Tab>("upload");
  const [submitting, setSubmitting] = useState(false);
  const [uploadPercent, setUploadPercent] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<JobState | null>(null);

  // Guards against setState after unmount when a poll or upload is in flight.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Poll job status until it reaches a terminal state, then route to the result.
  useEffect(() => {
    if (!job?.active) return;

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    async function poll() {
      try {
        const response = await fetch(`/api/jobs/${job!.id}`, {
          signal: controller.signal,
          cache: "no-store",
        });
        if (!response.ok) throw new Error(`Status check failed (${response.status})`);

        const next = (await response.json()) as JobState;
        if (stopped || !mounted.current) return;

        setJob(next);

        if (next.status === "succeeded") {
          router.push(`/analyses/${next.videoId}`);
          return;
        }
        if (!next.active) return;

        timer = setTimeout(poll, 2500);
      } catch (err) {
        if (controller.signal.aborted || stopped || !mounted.current) return;
        // A transient network blip shouldn't end the poll — the job is still
        // running server-side. Back off and try again.
        timer = setTimeout(poll, 5000);
        console.warn("Job poll failed, retrying:", err);
      }
    }

    timer = setTimeout(poll, 1500);

    return () => {
      stopped = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [job, router]);

  const startJob = useCallback(async (body: unknown) => {
    const response = await fetch("/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(payload.error ?? `Could not queue the job (${response.status}).`);
    }

    return payload as { jobId: string; videoId: string };
  }, []);

  async function handleFileSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const form = new FormData(event.currentTarget);
    const file = form.get("file");
    const title = String(form.get("title") ?? "").trim();
    const notes = String(form.get("notes") ?? "").trim();

    if (!(file instanceof File) || file.size === 0) {
      setError("Choose a video file first.");
      return;
    }
    if (file.size > maxUploadBytes) {
      setError(
        `That file is ${(file.size / 1024 / 1024).toFixed(0)} MB. The limit is ` +
          `${Math.round(maxUploadBytes / 1024 / 1024)} MB.`,
      );
      return;
    }
    if (file.type && !ACCEPTED_TYPES.includes(file.type)) {
      setError(`${file.type} isn't a supported video format. Use MP4, MOV, WebM, or MKV.`);
      return;
    }

    setSubmitting(true);
    setUploadPercent(0);

    try {
      // Upload straight to Storage rather than through a route handler — a
      // 500 MB video would blow past the serverless request body limit.
      const supabase = createClient();
      const extension = file.name.split(".").pop()?.toLowerCase() ?? "mp4";
      const storagePath = `${userId}/pending-${crypto.randomUUID()}/source.${extension}`;

      const { error: uploadError } = await supabase.storage
        .from("footage")
        .upload(storagePath, file, {
          contentType: file.type || "video/mp4",
          upsert: false,
        });

      if (uploadError) {
        throw new Error(`Upload failed: ${uploadError.message}`);
      }

      setUploadPercent(100);

      const { jobId, videoId } = await startJob({
        source: "upload",
        storagePath,
        title: title || file.name,
        notes: notes || undefined,
        sizeBytes: file.size,
      });

      if (!mounted.current) return;
      setJob({
        id: jobId,
        videoId,
        status: "queued",
        stageDetail: "Queued",
        progress: 0,
        error: null,
        active: true,
      });
    } catch (err) {
      if (mounted.current) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (mounted.current) {
        setSubmitting(false);
        setUploadPercent(null);
      }
    }
  }

  async function handleYouTubeSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const form = new FormData(event.currentTarget);
    const sourceUrl = String(form.get("sourceUrl") ?? "").trim();
    const title = String(form.get("title") ?? "").trim();
    const notes = String(form.get("notes") ?? "").trim();
    const start = String(form.get("clipStartSeconds") ?? "").trim();
    const end = String(form.get("clipEndSeconds") ?? "").trim();

    if (!sourceUrl) {
      setError("Paste a YouTube URL first.");
      return;
    }

    const clipStartSeconds = start === "" ? undefined : Number(start);
    const clipEndSeconds = end === "" ? undefined : Number(end);

    if (
      clipStartSeconds !== undefined &&
      clipEndSeconds !== undefined &&
      clipEndSeconds <= clipStartSeconds
    ) {
      setError("Clip end must be after clip start.");
      return;
    }

    setSubmitting(true);

    try {
      const { jobId, videoId } = await startJob({
        source: "youtube",
        sourceUrl,
        title: title || "YouTube clip",
        notes: notes || undefined,
        clipStartSeconds,
        clipEndSeconds,
      });

      if (!mounted.current) return;
      setJob({
        id: jobId,
        videoId,
        status: "queued",
        stageDetail: "Queued",
        progress: 0,
        error: null,
        active: true,
      });
    } catch (err) {
      if (mounted.current) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (mounted.current) setSubmitting(false);
    }
  }

  if (!accepted) {
    return <TermsGate onAccepted={() => setAccepted(true)} />;
  }

  if (job) {
    return (
      <JobProgress
        job={job}
        onReset={() => {
          setJob(null);
          setError(null);
        }}
      />
    );
  }

  const fieldClass =
    "w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted";
  const labelClass = "mb-1.5 block text-sm font-medium text-foreground";

  return (
    <div>
      <div
        role="tablist"
        aria-label="Footage source"
        className="mb-6 inline-flex rounded-md border border-border bg-surface p-1"
      >
        {(
          [
            ["upload", "Upload a file"],
            ["youtube", "YouTube URL"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            role="tab"
            type="button"
            aria-selected={tab === value}
            onClick={() => {
              setTab(value);
              setError(null);
            }}
            className={`rounded px-4 py-1.5 text-sm font-medium transition-colors ${
              tab === value
                ? "bg-accent text-white"
                : "text-muted hover:text-foreground"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {error ? (
        <p
          role="alert"
          className="mb-5 rounded-md border border-accent/40 bg-accent-soft px-4 py-3 text-sm text-foreground"
        >
          {error}
        </p>
      ) : null}

      {tab === "upload" ? (
        <form onSubmit={handleFileSubmit} className="space-y-5">
          <div>
            <label htmlFor="file" className={labelClass}>
              Video file
            </label>
            <input
              id="file"
              name="file"
              type="file"
              accept={ACCEPTED_TYPES.join(",")}
              required
              className="w-full rounded-md border border-dashed border-border bg-surface px-3 py-6 text-sm text-muted file:mr-4 file:rounded file:border-0 file:bg-surface-raised file:px-3 file:py-1.5 file:text-sm file:text-foreground"
            />
            <p className="mt-1.5 text-xs text-muted">
              MP4, MOV, WebM, or MKV. Up to{" "}
              {Math.round(maxUploadBytes / 1024 / 1024)} MB and{" "}
              {maxClipSeconds} seconds.
            </p>
          </div>

          <div>
            <label htmlFor="title" className={labelClass}>
              Title
            </label>
            <input
              id="title"
              name="title"
              type="text"
              maxLength={200}
              className={fieldClass}
              placeholder="Tuesday sparring — round 3"
            />
          </div>

          <div>
            <label htmlFor="notes" className={labelClass}>
              Notes <span className="font-normal text-muted">(optional)</span>
            </label>
            <textarea
              id="notes"
              name="notes"
              rows={3}
              maxLength={2000}
              className={fieldClass}
              placeholder="Anything you want the analysis to pay attention to — a nagging habit, a technique you're drilling."
            />
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="rounded-md bg-accent px-5 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting
              ? uploadPercent !== null
                ? "Uploading…"
                : "Queueing…"
              : "Analyze footage"}
          </button>
        </form>
      ) : (
        <form onSubmit={handleYouTubeSubmit} className="space-y-5">
          <div>
            <label htmlFor="sourceUrl" className={labelClass}>
              YouTube URL
            </label>
            <input
              id="sourceUrl"
              name="sourceUrl"
              type="url"
              required
              className={fieldClass}
              placeholder="https://www.youtube.com/watch?v=…"
            />
            <p className="mt-1.5 text-xs text-muted">
              Only submit footage you own or have the right to use.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="clipStartSeconds" className={labelClass}>
                Start{" "}
                <span className="font-normal text-muted">(seconds, optional)</span>
              </label>
              <input
                id="clipStartSeconds"
                name="clipStartSeconds"
                type="number"
                min={0}
                className={fieldClass}
                placeholder="0"
              />
            </div>
            <div>
              <label htmlFor="clipEndSeconds" className={labelClass}>
                End{" "}
                <span className="font-normal text-muted">(seconds, optional)</span>
              </label>
              <input
                id="clipEndSeconds"
                name="clipEndSeconds"
                type="number"
                min={0}
                className={fieldClass}
                placeholder={String(maxClipSeconds)}
              />
            </div>
          </div>

          <div>
            <label htmlFor="yt-title" className={labelClass}>
              Title
            </label>
            <input
              id="yt-title"
              name="title"
              type="text"
              maxLength={200}
              className={fieldClass}
              placeholder="Amateur bout — round 1"
            />
          </div>

          <div>
            <label htmlFor="yt-notes" className={labelClass}>
              Notes <span className="font-normal text-muted">(optional)</span>
            </label>
            <textarea
              id="yt-notes"
              name="notes"
              rows={3}
              maxLength={2000}
              className={fieldClass}
              placeholder="Which fighter should the analysis focus on?"
            />
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="rounded-md bg-accent px-5 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? "Queueing…" : "Analyze footage"}
          </button>
        </form>
      )}
    </div>
  );
}

const STAGE_ORDER: JobStatus[] = [
  "queued",
  "fetching",
  "extracting",
  "posing",
  "analyzing",
];

function JobProgress({
  job,
  onReset,
}: {
  job: JobState;
  onReset: () => void;
}) {
  const failed = job.status === "failed";
  const currentIndex = STAGE_ORDER.indexOf(job.status);

  return (
    <div className="rounded-lg border border-border bg-surface p-6">
      <h2 className="display mb-1 text-xl">
        {failed ? "Analysis failed" : "Analyzing your footage"}
      </h2>
      <p className="mb-6 text-sm text-muted">
        {failed
          ? "Something went wrong in the pipeline."
          : "This runs in the background — you can leave this page and check My clips later."}
      </p>

      {!failed ? (
        <>
          <div
            className="mb-5 h-1.5 w-full overflow-hidden rounded-full bg-surface-raised"
            role="progressbar"
            aria-valuenow={job.progress}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Analysis progress"
          >
            <div
              className="h-full rounded-full bg-accent transition-all duration-500"
              style={{ width: `${Math.max(job.progress, 4)}%` }}
            />
          </div>

          <ol className="mb-6 space-y-2.5">
            {STAGE_ORDER.map((stage, index) => {
              const done = currentIndex > index;
              const active = currentIndex === index;
              return (
                <li key={stage} className="flex items-center gap-3 text-sm">
                  <span
                    aria-hidden
                    className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] ${
                      done
                        ? "border-success bg-success text-white"
                        : active
                          ? "border-accent text-accent"
                          : "border-border text-muted"
                    }`}
                  >
                    {done ? "✓" : index + 1}
                  </span>
                  <span className={active ? "text-foreground" : "text-muted"}>
                    {JOB_STAGE_LABELS[stage]}
                  </span>
                </li>
              );
            })}
          </ol>

          {job.stageDetail ? (
            <p className="text-sm text-muted" role="status" aria-live="polite">
              {job.stageDetail}
            </p>
          ) : null}
        </>
      ) : (
        <>
          <p
            role="alert"
            className="mb-5 rounded-md border border-accent/40 bg-accent-soft px-4 py-3 text-sm text-foreground"
          >
            {job.error ?? "Unknown error."}
          </p>
          <button
            type="button"
            onClick={onReset}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
          >
            Try another clip
          </button>
        </>
      )}
    </div>
  );
}
