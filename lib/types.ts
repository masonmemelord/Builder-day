/**
 * Hand-written mirror of supabase/migrations/0001_init.sql.
 *
 * Regenerate with:
 *   npx supabase gen types typescript --project-id <ref> > lib/database.types.ts
 * and re-point the aliases at the bottom if you prefer generated types.
 */

export type VideoSource = "upload" | "youtube";

export type JobStatus =
  | "queued"
  | "fetching"
  | "extracting"
  | "posing"
  | "analyzing"
  | "succeeded"
  | "failed"
  | "canceled";

/** Statuses where the pipeline is still doing work. */
export const ACTIVE_JOB_STATUSES: readonly JobStatus[] = [
  "queued",
  "fetching",
  "extracting",
  "posing",
  "analyzing",
] as const;

export function isJobActive(status: JobStatus): boolean {
  return ACTIVE_JOB_STATUSES.includes(status);
}

/** Human-readable stage labels, used by the progress UI. */
export const JOB_STAGE_LABELS: Record<JobStatus, string> = {
  queued: "Queued",
  fetching: "Fetching footage",
  extracting: "Extracting frames",
  posing: "Estimating pose",
  analyzing: "Analyzing footage",
  succeeded: "Complete",
  failed: "Failed",
  canceled: "Canceled",
};

export interface Profile {
  id: string;
  email: string | null;
  display_name: string | null;
  terms_accepted_at: string | null;
  terms_version: string | null;
  created_at: string;
  updated_at: string;
}

export interface Video {
  id: string;
  user_id: string;
  source: VideoSource;
  title: string;
  notes: string | null;
  storage_path: string | null;
  source_url: string | null;
  clip_start_seconds: number | null;
  clip_end_seconds: number | null;
  duration_seconds: number | null;
  size_bytes: number | null;
  created_at: string;
  updated_at: string;
}

export interface AnalysisJob {
  id: string;
  video_id: string;
  user_id: string;
  status: JobStatus;
  stage_detail: string | null;
  progress: number;
  attempts: number;
  max_attempts: number;
  error: string | null;
  locked_at: string | null;
  locked_by: string | null;
  run_after: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

/** A single MediaPipe Pose landmark. Coordinates are normalised to [0, 1]. */
export interface PoseLandmark {
  x: number;
  y: number;
  z: number;
  visibility: number;
}

export interface VideoFrame {
  id: string;
  video_id: string;
  user_id: string;
  frame_index: number;
  timestamp_seconds: number;
  storage_path: string;
  width: number | null;
  height: number | null;
  landmarks: PoseLandmark[] | null;
  pose_score: number | null;
  created_at: string;
}

// --- Analysis payload -------------------------------------------------------
// These shapes are enforced by the JSON schema in lib/pipeline/analyze.ts, so
// the model cannot return anything that doesn't parse into them.

export interface StanceAssessment {
  orthodox_or_southpaw: "orthodox" | "southpaw" | "switching" | "unclear";
  width: "narrow" | "balanced" | "wide";
  weight_distribution: string;
  observations: string;
}

export interface GuardAssessment {
  height: "low" | "mid" | "high" | "varies";
  style: string;
  hand_return_speed: "slow" | "average" | "fast" | "unclear";
  observations: string;
}

export interface FootworkAssessment {
  mobility: "static" | "measured" | "mobile" | "erratic";
  patterns: string[];
  observations: string;
}

export interface OutputRateAssessment {
  estimated_strikes_per_minute: number | null;
  volume: "low" | "moderate" | "high";
  pressure_vs_counter: "pressure" | "counter" | "balanced" | "unclear";
  observations: string;
}

export interface ProComparison {
  fighter: string;
  discipline: string;
  confidence: "low" | "medium" | "high";
  shared_traits: string[];
  key_differences: string[];
  reasoning: string;
}

export interface TechnicalGap {
  area: string;
  severity: "minor" | "moderate" | "significant";
  description: string;
  frame_references: number[];
}

export interface Drill {
  name: string;
  targets: string;
  description: string;
  sets_and_reps: string;
}

/** Exactly what the model returns, before it is split across table columns. */
export interface AnalysisPayload {
  summary: string;
  stance: StanceAssessment;
  guard: GuardAssessment;
  footwork: FootworkAssessment;
  output_rate: OutputRateAssessment;
  pro_comparison: ProComparison;
  technical_gaps: TechnicalGap[];
  drills: Drill[];
}

export interface Analysis {
  id: string;
  video_id: string;
  user_id: string;
  model: string;
  frames_analyzed: number;
  summary: string;
  stance: StanceAssessment;
  guard: GuardAssessment;
  footwork: FootworkAssessment;
  output_rate: OutputRateAssessment;
  pro_comparison: ProComparison;
  technical_gaps: TechnicalGap[];
  drills: Drill[];
  raw: AnalysisPayload | null;
  created_at: string;
}

/** Row shape returned by the `claim_next_job` RPC. */
export type ClaimedJob = AnalysisJob | null;
