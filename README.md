# Fight IQ

AI-powered combat sports film study. Upload sparring footage (a file or a
YouTube link), and the app extracts frames, runs pose estimation, and has a
vision model read stance, guard, footwork, and output rate — then compares the athlete's
style to a professional and prescribes drills.

> **Test tool only — not for profit, not professional advice.**
> This is an experimental proof of concept, not a commercial product. The
> analysis is AI-generated, carries no warranty of accuracy, and is not
> coaching, medical, or injury-prevention advice. See `/terms`.

---

## Stack

| Layer | Choice |
|---|---|
| Frontend | Next.js 16 (App Router), React 19, Tailwind v4 |
| Auth / DB / Storage | Supabase (email + password, Postgres, private buckets) |
| Vision | OpenAI vision model (`gpt-4o` by default) with strict structured outputs |
| Pose | MediaPipe Pose (optional dependency) |
| Video | `ffmpeg` + `yt-dlp` binaries, invoked from a Node-runtime route |

The processing route is **Node runtime, not edge** — `ffmpeg` and `yt-dlp` are
real binaries and cannot run on an edge runtime.

---

## Setup

### 1. Install

```bash
npm install
cp .env.example .env.local
```

### 2. Supabase

Create a project, then apply the schema:

```bash
npx supabase link --project-ref <your-ref>
npx supabase db push
```

Or paste `supabase/migrations/0001_init.sql` into the SQL editor. It creates the
tables, RLS policies, both storage buckets, and the `claim_next_job` locking
function.

In **Authentication → Providers → Email**, decide whether to require email
confirmation. With it on, signup returns "check your email" instead of logging
straight in — the UI handles both.

Fill in `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and
`SUPABASE_SERVICE_ROLE_KEY` in `.env.local`.

### 3. OpenAI

Set `OPENAI_API_KEY`. The model defaults to `gpt-4o` — override with
`OPENAI_MODEL` to whatever your account has access to. It must be
**vision-capable** and support **strict structured outputs**; those two
requirements are the only constraint.

For Azure OpenAI or a proxy, set `OPENAI_BASE_URL`.

### 4. Worker secret

```bash
openssl rand -hex 32
```

Put it in `WORKER_SECRET`. On Vercel, also set the same value as `CRON_SECRET`
so the scheduled invocation authorises.

### 5. Binaries (for real analysis)

```bash
brew install ffmpeg          # provides ffmpeg + ffprobe
brew install yt-dlp          # or: pip install -U yt-dlp
```

Optional, for real pose estimation:

```bash
npm install @mediapipe/tasks-vision @napi-rs/canvas
mkdir -p models
# download pose_landmarker_lite.task into models/ from
# https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker
```

**Without these, the pipeline still runs end to end but each affected stage
falls back to a documented stub** — a missing `ffmpeg` yields one placeholder
frame, a missing MediaPipe yields null landmarks. That keeps the job lifecycle
exercisable without the binaries; it does not produce a real analysis.

Set `PIPELINE_STRICT_BINARIES=1` in any deployment meant to produce real
results — a missing binary then fails the job loudly instead of silently
degrading.

### 6. Run

```bash
npm run dev
```

---

## Architecture

### Ingestion converges on one path

```
File upload ──► browser uploads straight to Storage ──┐
                                                      ├─► videos.storage_path ─► one job
YouTube URL ──► yt-dlp fetch (+ optional clip window) ┘
```

Uploads go **browser → Supabase Storage directly**, not through a route handler:
a 500 MB video would blow past the serverless request body limit. The route only
receives the resulting storage path, and verifies it belongs to the caller.

### Processing is async

Video processing exceeds normal request timeouts, so nothing runs in the request
that starts it. `POST /api/jobs` creates a row in `analysis_jobs` and returns
immediately; the client polls `GET /api/jobs/:id`.

Jobs are claimed through the `claim_next_job` Postgres function, which uses
`FOR UPDATE SKIP LOCKED` so concurrent workers take different jobs rather than
blocking. Claims are **leases** — a worker killed mid-job (a Vercel timeout)
releases its claim after 15 minutes and the job becomes claimable again.

The worker is driven two ways: fired opportunistically after a job is created,
and backstopped by a Vercel cron every 5 minutes (`vercel.json`). The cron is
what makes the system correct; the opportunistic kick just removes the wait.

### Pipeline stages

1. **Ingest** — download from Storage, or fetch via `yt-dlp` and upload to the
   same bucket layout.
2. **Extract** — `ffmpeg` at 1 fps, scaled to 720px wide. Frames go to the
   private `frames` bucket.
3. **Pose** — MediaPipe emits 33 landmarks per frame. Frames with no detected
   pose store `null` rather than being dropped: "the athlete left frame" is
   information, and dropping frames would distort the timeline.
4. **Analyze** — frames plus a derived pose-metrics table go to the vision model.
5. **Store** — the result is written to `analyses`, keyed uniquely by
   `video_id`. Re-viewing a result never reprocesses.

### Why a metrics table instead of raw landmarks

33 coordinates × 20 frames is ~15k tokens of noise. Instead the worker derives
four ratios per frame — stance width, guard height, lead-foot offset, torso
rotation — all normalised against shoulder width so they're comparable across
camera distances, and sends those as a compact table alongside the images. The
system prompt tells the model how to read each one and what the thresholds mean.

### Structured outputs

The analysis request uses `response_format: { type: "json_schema", strict: true }`.
Strict mode imposes two rules on every object in the schema:
`additionalProperties: false`, and *every* property listed in `required`. There
are no optional keys — a field that may be absent (like an unestimable strike
rate) is typed as a union with `null` instead. Together these guarantee the
parsed result matches `AnalysisPayload` exactly, so the display layer never
defends against a missing key or prose where an array belongs.

### Cost controls

- Frames capped at `MAX_FRAMES_PER_ANALYSIS` (default 20), sampled evenly across
  the clip so output rate and footwork aren't judged from a biased window.
- Frames scaled to 720px: about 1.1k tokens per image at `detail: "high"`. A
  larger source costs proportionally more without making stance, guard, or foot
  placement more legible.
- Clips capped at `MAX_CLIP_SECONDS` (default 180).

---

## Security notes

- **Every table has RLS enabled**, owner-scoped on `user_id`. The service-role
  key bypasses RLS and is used only by the worker.
- `analysis_jobs` is deliberately **not** client-updatable — only the worker
  moves a job through its lifecycle, so a client can't mark its own job
  succeeded. `video_frames` and `analyses` are client-read-only.
- Storage buckets are private, with policies keyed on the leading path segment
  (`<user_id>/<video_id>/…`).
- The ToS gate is enforced in `POST /api/jobs`, not just in the modal.
- YouTube URLs are checked against a host **allowlist** before reaching
  `yt-dlp`.
- The worker secret is compared with `timingSafeEqual`.
- Sign-in failures don't distinguish "no such user" from "wrong password".

---

## Known gaps

- **Upload progress is binary.** The Supabase JS client doesn't expose upload
  progress events, so the UI shows "Uploading…" rather than a percentage. A
  resumable TUS upload would fix it.
- **No delete UI.** Rows cascade correctly on user deletion, but there's no
  per-clip delete button yet.
- **Vercel's function timeout bounds clip length.** `maxDuration` is 300s. A
  long clip on the free tier will hit it, release its lease, and retry until it
  exhausts `max_attempts`. That's the point at which to move the pipeline to a
  standalone worker — `lib/pipeline/worker.ts` takes a Supabase client and has
  no Next.js dependency, so it lifts out as-is.
- **SwiftUI iOS client** is a stretch goal and not started.

---

## Layout

```
app/
  actions/          server actions (auth, terms acceptance)
  api/jobs/         create + poll analysis jobs
  api/worker/       Node-runtime job processor (cron + opportunistic)
  analyses/         results list and detail
  terms/            ToS page
  upload/           upload UI
components/         Footer (global disclaimer), UploadForm, TermsGate, AnalysisView
lib/
  pipeline/         ingest → frames → pose → analyze → worker
  supabase/         browser, server, admin clients + session proxy
supabase/migrations/
proxy.ts            session refresh + route gating (Next 16 middleware convention)
```
