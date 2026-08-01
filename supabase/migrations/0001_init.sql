-- Fight IQ — initial schema
-- Test/demo project. Not for production use.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type public.video_source as enum ('upload', 'youtube');

create type public.job_status as enum (
  'queued',
  'fetching',     -- downloading from YouTube / confirming the upload landed
  'extracting',   -- ffmpeg frame extraction
  'posing',       -- MediaPipe pose estimation
  'analyzing',    -- Claude vision analysis
  'succeeded',
  'failed',
  'canceled'
);

-- ---------------------------------------------------------------------------
-- profiles — mirrors auth.users, holds the ToS acknowledgement
-- ---------------------------------------------------------------------------

create table public.profiles (
  id                uuid primary key references auth.users (id) on delete cascade,
  email             text,
  display_name      text,
  terms_accepted_at timestamptz,
  terms_version     text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on column public.profiles.terms_version is
  'Version string of the ToS the user acknowledged. Bumping TERMS_VERSION in code re-prompts everyone.';

-- ---------------------------------------------------------------------------
-- videos — one row per piece of footage, whichever path it arrived by
-- ---------------------------------------------------------------------------

create table public.videos (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users (id) on delete cascade,
  source              public.video_source not null,
  title               text not null default 'Untitled clip',
  notes               text,

  -- Populated for both paths once ingestion completes. This is the convergence
  -- point: after fetching, a YouTube video is indistinguishable from an upload.
  storage_path        text,

  -- YouTube-only
  source_url          text,
  clip_start_seconds  integer check (clip_start_seconds is null or clip_start_seconds >= 0),
  clip_end_seconds    integer check (clip_end_seconds is null or clip_end_seconds >= 0),

  duration_seconds    numeric,
  size_bytes          bigint,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint videos_clip_range_valid
    check (
      clip_start_seconds is null
      or clip_end_seconds is null
      or clip_end_seconds > clip_start_seconds
    ),
  constraint videos_source_fields_present
    check (
      (source = 'upload'  and storage_path is not null)
      or (source = 'youtube' and source_url is not null)
    )
);

create index videos_user_id_created_at_idx on public.videos (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- analysis_jobs — the async queue. One active job per video.
-- ---------------------------------------------------------------------------

create table public.analysis_jobs (
  id            uuid primary key default gen_random_uuid(),
  video_id      uuid not null references public.videos (id) on delete cascade,
  user_id       uuid not null references auth.users (id) on delete cascade,

  status        public.job_status not null default 'queued',
  stage_detail  text,
  progress      smallint not null default 0 check (progress between 0 and 100),

  attempts      smallint not null default 0,
  max_attempts  smallint not null default 3,
  error         text,

  -- Lease-based locking so two concurrent workers can't claim the same job.
  locked_at     timestamptz,
  locked_by     text,
  run_after     timestamptz not null default now(),

  created_at    timestamptz not null default now(),
  started_at    timestamptz,
  finished_at   timestamptz
);

create index analysis_jobs_claimable_idx
  on public.analysis_jobs (run_after)
  where status = 'queued';

create index analysis_jobs_user_id_created_at_idx
  on public.analysis_jobs (user_id, created_at desc);

create index analysis_jobs_video_id_idx on public.analysis_jobs (video_id);

-- At most one unfinished job per video.
create unique index analysis_jobs_one_active_per_video_idx
  on public.analysis_jobs (video_id)
  where status not in ('succeeded', 'failed', 'canceled');

-- ---------------------------------------------------------------------------
-- video_frames — extracted frames plus their pose landmarks
-- ---------------------------------------------------------------------------

create table public.video_frames (
  id                uuid primary key default gen_random_uuid(),
  video_id          uuid not null references public.videos (id) on delete cascade,
  user_id           uuid not null references auth.users (id) on delete cascade,
  frame_index       integer not null,
  timestamp_seconds numeric not null,
  storage_path      text not null,
  width             integer,
  height            integer,

  -- MediaPipe Pose output: 33 normalised landmarks, or null when no pose was
  -- detected in the frame (which is itself a signal worth keeping).
  landmarks         jsonb,
  pose_score        numeric,

  created_at        timestamptz not null default now(),

  unique (video_id, frame_index)
);

create index video_frames_video_id_frame_index_idx
  on public.video_frames (video_id, frame_index);

-- ---------------------------------------------------------------------------
-- analyses — the cached Claude result, keyed to the video so re-viewing a
-- result never reprocesses the footage.
-- ---------------------------------------------------------------------------

create table public.analyses (
  id               uuid primary key default gen_random_uuid(),
  video_id         uuid not null unique references public.videos (id) on delete cascade,
  user_id          uuid not null references auth.users (id) on delete cascade,

  model            text not null,
  frames_analyzed  smallint not null default 0,

  summary          text not null,
  stance           jsonb not null default '{}'::jsonb,
  guard            jsonb not null default '{}'::jsonb,
  footwork         jsonb not null default '{}'::jsonb,
  output_rate      jsonb not null default '{}'::jsonb,
  pro_comparison   jsonb not null default '{}'::jsonb,
  technical_gaps   jsonb not null default '[]'::jsonb,
  drills           jsonb not null default '[]'::jsonb,

  -- Full model payload, kept so the display layer can evolve without a reprocess.
  raw              jsonb,

  created_at       timestamptz not null default now()
);

create index analyses_user_id_created_at_idx on public.analyses (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

create trigger videos_set_updated_at
  before update on public.videos
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Auto-create a profile row on signup
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Row Level Security
--
-- Every table is owner-scoped. The worker uses the service-role key, which
-- bypasses RLS entirely — these policies exist to constrain the browser client.
-- ---------------------------------------------------------------------------

alter table public.profiles      enable row level security;
alter table public.videos        enable row level security;
alter table public.analysis_jobs enable row level security;
alter table public.video_frames  enable row level security;
alter table public.analyses      enable row level security;

-- profiles: a user can read and update only their own row. No insert policy —
-- rows are created by the signup trigger; no delete policy — cascade from auth.
create policy "profiles_select_own" on public.profiles
  for select using ((select auth.uid()) = id);

create policy "profiles_update_own" on public.profiles
  for update using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- videos: full ownership.
create policy "videos_select_own" on public.videos
  for select using ((select auth.uid()) = user_id);

create policy "videos_insert_own" on public.videos
  for insert with check ((select auth.uid()) = user_id);

create policy "videos_update_own" on public.videos
  for update using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "videos_delete_own" on public.videos
  for delete using ((select auth.uid()) = user_id);

-- analysis_jobs: readable and creatable by the owner. Deliberately NOT
-- updatable from the browser — only the service-role worker moves a job
-- through its lifecycle, so a client can't mark its own job succeeded.
create policy "analysis_jobs_select_own" on public.analysis_jobs
  for select using ((select auth.uid()) = user_id);

create policy "analysis_jobs_insert_own" on public.analysis_jobs
  for insert with check ((select auth.uid()) = user_id);

-- video_frames: read-only from the browser. Written by the worker.
create policy "video_frames_select_own" on public.video_frames
  for select using ((select auth.uid()) = user_id);

-- analyses: read-only from the browser. Written by the worker.
create policy "analyses_select_own" on public.analyses
  for select using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- Storage buckets
--
-- Both private. Paths are always `<user_id>/<video_id>/...` so the RLS policies
-- below can authorise on the leading path segment.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'footage',
  'footage',
  false,
  524288000, -- 500 MB
  array['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska']
)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('frames', 'frames', false, 10485760, array['image/jpeg', 'image/png'])
on conflict (id) do nothing;

create policy "footage_select_own" on storage.objects
  for select using (
    bucket_id = 'footage'
    and (select auth.uid())::text = (storage.foldername(name))[1]
  );

create policy "footage_insert_own" on storage.objects
  for insert with check (
    bucket_id = 'footage'
    and (select auth.uid())::text = (storage.foldername(name))[1]
  );

create policy "footage_delete_own" on storage.objects
  for delete using (
    bucket_id = 'footage'
    and (select auth.uid())::text = (storage.foldername(name))[1]
  );

-- Frames are written by the worker (service role) and only read by the owner.
create policy "frames_select_own" on storage.objects
  for select using (
    bucket_id = 'frames'
    and (select auth.uid())::text = (storage.foldername(name))[1]
  );

-- ---------------------------------------------------------------------------
-- claim_next_job — atomic job lease.
--
-- SKIP LOCKED means two workers racing will each get a different job rather
-- than one blocking on the other. The lease expires after `p_lease_seconds`
-- so a worker killed mid-job (Vercel timeout) releases its claim.
-- ---------------------------------------------------------------------------

create or replace function public.claim_next_job(
  p_worker_id     text,
  p_lease_seconds integer default 900
)
returns public.analysis_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed public.analysis_jobs;
begin
  -- Release expired leases so stalled jobs become claimable again.
  update public.analysis_jobs
     set status    = 'queued',
         locked_at = null,
         locked_by = null
   where locked_at is not null
     and locked_at < now() - make_interval(secs => p_lease_seconds)
     and status not in ('succeeded', 'failed', 'canceled');

  with next_job as (
    select id
      from public.analysis_jobs
     where status = 'queued'
       and run_after <= now()
     order by created_at
     for update skip locked
     limit 1
  )
  update public.analysis_jobs j
     set status     = 'fetching',
         locked_at  = now(),
         locked_by  = p_worker_id,
         attempts   = j.attempts + 1,
         started_at = coalesce(j.started_at, now()),
         error      = null
    from next_job
   where j.id = next_job.id
  returning j.* into claimed;

  return claimed;
end;
$$;

revoke all on function public.claim_next_job(text, integer) from public, anon, authenticated;
