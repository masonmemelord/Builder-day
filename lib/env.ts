/**
 * Centralised environment access.
 *
 * Anything read here is read once, at module load, and fails loudly rather than
 * producing a client pointed at `undefined`. Server-only values are guarded so
 * an accidental client import surfaces at build time instead of leaking a key.
 */

function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. See .env.example.`,
    );
  }
  return value;
}

function serverOnly(name: string): string {
  if (typeof window !== "undefined") {
    throw new Error(`${name} is server-only and must never reach the browser.`);
  }
  return required(name, process.env[name]);
}

/**
 * Public values, resolved lazily.
 *
 * Getters rather than eager fields: `next build` evaluates every module, and an
 * eager `required()` would fail the build on a machine that has no .env.local
 * even though nothing at build time needs a live Supabase connection.
 */
export const publicEnv = {
  get supabaseUrl() {
    return required(
      "NEXT_PUBLIC_SUPABASE_URL",
      process.env.NEXT_PUBLIC_SUPABASE_URL,
    );
  },
  get supabaseAnonKey() {
    return required(
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    );
  },
} as const;

/** Server-only secrets. Accessing any of these from a Client Component throws. */
export const serverEnv = {
  get supabaseServiceRoleKey() {
    return serverOnly("SUPABASE_SERVICE_ROLE_KEY");
  },
  get openaiApiKey() {
    return serverOnly("OPENAI_API_KEY");
  },
  /** Shared secret required by /api/worker/process. Also used by the Vercel cron. */
  get workerSecret() {
    return serverOnly("WORKER_SECRET");
  },
} as const;

/** Model + pipeline tuning. Safe to read anywhere. */
export const config = {
  /**
   * Must be vision-capable and support strict structured outputs. gpt-4o is a
   * safe default; override to whatever your account has access to.
   */
  model: process.env.OPENAI_MODEL ?? "gpt-4o",

  /** Optional override for Azure OpenAI or a proxy. */
  openaiBaseUrl: process.env.OPENAI_BASE_URL,

  /** Frame extraction rate. ~1fps is enough to read stance and output rate. */
  framesPerSecond: Number(process.env.FRAME_RATE ?? "1"),

  /**
   * Hard cap on frames sent to the vision endpoint in one request. Each image
   * costs up to ~4.8k tokens at full resolution, so this bounds request size
   * and cost. Frames are sampled evenly across the clip when we exceed it.
   */
  maxFramesPerAnalysis: Number(process.env.MAX_FRAMES_PER_ANALYSIS ?? "20"),

  /** Longest clip we will process. Keeps a demo upload from running for an hour. */
  maxClipSeconds: Number(process.env.MAX_CLIP_SECONDS ?? "180"),

  maxUploadBytes: 500 * 1024 * 1024,

  /**
   * Bumping this re-prompts every user for ToS acknowledgement, because the
   * gate compares this against profiles.terms_version.
   */
  termsVersion: "2026-08-01",
} as const;

export const BUCKETS = {
  footage: "footage",
  frames: "frames",
} as const;
