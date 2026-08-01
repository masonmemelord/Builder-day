import "server-only";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * The pipeline shells out to two real binaries. In environments where they
 * aren't installed (local dev without ffmpeg, a bare Vercel Node runtime) each
 * stage degrades to a documented stub rather than crashing the job, so the
 * shape of the pipeline stays exercisable end to end.
 *
 * Set PIPELINE_STRICT_BINARIES=1 to turn a missing binary into a hard failure —
 * you want that in any deployment that is meant to produce real analyses.
 */
export const STRICT_BINARIES = process.env.PIPELINE_STRICT_BINARIES === "1";

export const FFMPEG_PATH = process.env.FFMPEG_PATH ?? "ffmpeg";
export const FFPROBE_PATH = process.env.FFPROBE_PATH ?? "ffprobe";
export const YT_DLP_PATH = process.env.YT_DLP_PATH ?? "yt-dlp";

const availabilityCache = new Map<string, Promise<boolean>>();

/**
 * The flag each binary answers a version query with.
 *
 * ffmpeg/ffprobe accept the single-dash form; yt-dlp does not — it parses
 * `-version` as the bundled short flags `-v -e -r -s -i -o -n` and prints a
 * usage message. That happens to exit 0, so the probe passes either way, but
 * only by accident. Ask each tool the way it expects.
 */
function versionFlag(binary: string): string {
  return /yt-dlp/.test(binary) ? "--version" : "-version";
}

/**
 * Probes a binary once per process and caches the result.
 *
 * The cache stores the promise rather than the resolved value so concurrent
 * callers during startup share a single probe instead of racing.
 */
export function isAvailable(binary: string): Promise<boolean> {
  const cached = availabilityCache.get(binary);
  if (cached) return cached;

  const probe = execFileAsync(binary, [versionFlag(binary)], { timeout: 5_000 })
    .then(() => true)
    .catch(() => false);

  availabilityCache.set(binary, probe);
  return probe;
}

export class MissingBinaryError extends Error {
  constructor(
    readonly binary: string,
    readonly installHint: string,
  ) {
    super(`Required binary "${binary}" is not available. ${installHint}`);
    this.name = "MissingBinaryError";
  }
}

/**
 * Returns true when the caller should run the real implementation.
 *
 * When the binary is missing: throws in strict mode, otherwise logs once and
 * returns false so the caller can fall back to its stub.
 */
export async function requireBinary(
  binary: string,
  installHint: string,
): Promise<boolean> {
  if (await isAvailable(binary)) return true;

  if (STRICT_BINARIES) {
    throw new MissingBinaryError(binary, installHint);
  }

  console.warn(
    `[pipeline] ${binary} not found — falling back to stub output. ${installHint}`,
  );
  return false;
}

export async function run(
  binary: string,
  args: string[],
  options: { timeoutMs?: number } = {},
): Promise<string> {
  const { stdout } = await execFileAsync(binary, args, {
    timeout: options.timeoutMs ?? 10 * 60_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}
