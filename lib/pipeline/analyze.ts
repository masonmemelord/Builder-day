import "server-only";

import { readFile } from "node:fs/promises";
import OpenAI from "openai";
import { config, serverEnv } from "@/lib/env";
import type { AnalysisPayload } from "@/lib/types";
import type { ExtractedFrame } from "./frames";
import { formatPoseTable, type FramePose } from "./pose";

let client: OpenAI | null = null;

function getClient(): OpenAI {
  client ??= new OpenAI({
    apiKey: serverEnv.openaiApiKey,
    ...(config.openaiBaseUrl ? { baseURL: config.openaiBaseUrl } : {}),
  });
  return client;
}

// ---------------------------------------------------------------------------
// Output schema
//
// Written for OpenAI strict structured outputs, which imposes two rules on
// every object: `additionalProperties: false`, and *every* property listed in
// `required`. There are no optional keys — a field that may be absent is typed
// as a union with null instead. Together these guarantee the parsed result
// matches AnalysisPayload exactly, so the display layer never has to defend
// against a missing key or prose where an array belongs.
// ---------------------------------------------------------------------------

const ANALYSIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "summary",
    "stance",
    "guard",
    "footwork",
    "output_rate",
    "pro_comparison",
    "technical_gaps",
    "drills",
  ],
  properties: {
    summary: {
      type: "string",
      description:
        "2-4 sentence plain-language read of what this athlete looks like. " +
        "Lead with the single most useful observation.",
    },
    stance: {
      type: "object",
      additionalProperties: false,
      required: [
        "orthodox_or_southpaw",
        "width",
        "weight_distribution",
        "observations",
      ],
      properties: {
        orthodox_or_southpaw: {
          type: "string",
          enum: ["orthodox", "southpaw", "switching", "unclear"],
        },
        width: { type: "string", enum: ["narrow", "balanced", "wide"] },
        weight_distribution: {
          type: "string",
          description:
            "e.g. 'roughly 60/40 onto the rear leg, heavier than ideal for lead-hand work'",
        },
        observations: { type: "string" },
      },
    },
    guard: {
      type: "object",
      additionalProperties: false,
      required: ["height", "style", "hand_return_speed", "observations"],
      properties: {
        height: { type: "string", enum: ["low", "mid", "high", "varies"] },
        style: {
          type: "string",
          description: "e.g. 'high-and-tight', 'Philly shell', 'long guard'",
        },
        hand_return_speed: {
          type: "string",
          enum: ["slow", "average", "fast", "unclear"],
        },
        observations: { type: "string" },
      },
    },
    footwork: {
      type: "object",
      additionalProperties: false,
      required: ["mobility", "patterns", "observations"],
      properties: {
        mobility: {
          type: "string",
          enum: ["static", "measured", "mobile", "erratic"],
        },
        patterns: {
          type: "array",
          items: { type: "string" },
          description:
            "Recurring movement habits, e.g. 'steps straight back under pressure'",
        },
        observations: { type: "string" },
      },
    },
    output_rate: {
      type: "object",
      additionalProperties: false,
      required: [
        "estimated_strikes_per_minute",
        "volume",
        "pressure_vs_counter",
        "observations",
      ],
      properties: {
        estimated_strikes_per_minute: {
          // Nullable union rather than an omitted key — strict mode has no
          // optional properties, and "cannot estimate" must stay expressible.
          type: ["number", "null"],
          description:
            "Null when the clip is too short or the sampling too sparse to estimate honestly.",
        },
        volume: { type: "string", enum: ["low", "moderate", "high"] },
        pressure_vs_counter: {
          type: "string",
          enum: ["pressure", "counter", "balanced", "unclear"],
        },
        observations: { type: "string" },
      },
    },
    pro_comparison: {
      type: "object",
      additionalProperties: false,
      required: [
        "fighter",
        "discipline",
        "confidence",
        "shared_traits",
        "key_differences",
        "reasoning",
      ],
      properties: {
        fighter: {
          type: "string",
          description: "A well-known professional whose style this most resembles.",
        },
        discipline: {
          type: "string",
          description: "e.g. 'boxing', 'MMA', 'Muay Thai', 'kickboxing'",
        },
        confidence: { type: "string", enum: ["low", "medium", "high"] },
        shared_traits: { type: "array", items: { type: "string" } },
        key_differences: {
          type: "array",
          items: { type: "string" },
          description:
            "Where the comparison breaks down. Never leave this empty — an " +
            "amateur never matches a professional on every axis.",
        },
        reasoning: {
          type: "string",
          description:
            "Ground this in specific observed mechanics (stance width, guard " +
            "height, pressure tendencies), not reputation or general vibe.",
        },
      },
    },
    technical_gaps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["area", "severity", "description", "frame_references"],
        properties: {
          area: { type: "string", description: "e.g. 'rear hand return'" },
          severity: {
            type: "string",
            enum: ["minor", "moderate", "significant"],
          },
          description: { type: "string" },
          frame_references: {
            type: "array",
            items: { type: "integer" },
            description: "Frame numbers from the supplied images.",
          },
        },
      },
    },
    drills: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "targets", "description", "sets_and_reps"],
        properties: {
          name: { type: "string" },
          targets: {
            type: "string",
            description: "Which identified gap this drill addresses.",
          },
          description: { type: "string" },
          sets_and_reps: { type: "string" },
        },
      },
    },
  },
} as const;

const SYSTEM_PROMPT = `You are a combat sports film analyst reviewing training footage for Fight IQ, an experimental analysis tool.

You are given frames sampled at a fixed rate from a single clip, plus a table of pose-estimation measurements derived from those same frames. Read both together: the images show technique and context, the measurements give you numbers that are hard to eyeball reliably.

How to read the pose table:
- stance width — ankle separation divided by shoulder width. ~1.0 is a balanced boxing stance; below ~0.8 is narrow and unstable laterally; above ~1.4 is wide and slow to turn over.
- guard height — vertical wrist position relative to the shoulder-to-eye span. 1.0 means hands at eye level, 0.0 means hands at shoulder level, negative means hands below the shoulders.
- lead foot offset — signed horizontal ankle separation. Sign tells you which foot leads relative to the camera, not which is objectively forward, so corroborate against the images before calling stance.
- torso rotation — shoulder line angle minus hip line angle, in degrees. Large values mean the athlete is loading rotation; near zero under strikes means arm-punching.
- "no pose detected" means the athlete left frame or was occluded. Treat those as gaps in the timeline, not as stillness.

How to analyse:
- Ground every claim in something observable. Reference specific frame numbers when you call out a fault.
- The measurements are noisy. A single outlier frame is not a pattern; three consistent frames is. When images and numbers disagree, trust the images and say so.
- Distinguish what you can see from what you are inferring. A clip that is too short, too dark, or shot from a bad angle limits what is knowable — say that plainly instead of filling the gap with plausible-sounding detail.
- For output rate, count what you can actually see across the sampled frames. Frames are sampled, not continuous, so strikes between samples are invisible to you. If the sampling is too sparse to support a number, return null rather than guessing.
- For the professional comparison, pick someone whose mechanics genuinely match and explain which mechanics. Always fill in key_differences. Set confidence to "low" when the footage is thin — a confident-sounding comparison from four blurry frames is worse than an honest "not enough to tell".
- Write drills a coach could actually run: specific, equipment-light, tied to a gap you identified.

Tone: direct and specific, the way a coach talks to an athlete. No hedging boilerplate, no motivational filler, no restating the task back.

This is an educational demo, not professional coaching. Do not give medical advice, injury diagnoses, or weight-cutting guidance.`;

export interface AnalyzeArgs {
  frames: ExtractedFrame[];
  poses: FramePose[];
  clipDurationSeconds: number | null;
  discipline?: string;
  userNotes?: string | null;
}

export interface AnalyzeResult {
  payload: AnalysisPayload;
  model: string;
  framesAnalyzed: number;
}

export class RefusalError extends Error {
  constructor(readonly detail: string | null) {
    super(
      `The model declined to analyze this footage${detail ? `: ${detail}` : "."} ` +
        "This can happen with graphic content. Try a different clip.",
    );
    this.name = "RefusalError";
  }
}

/**
 * Sends frames + pose data to the model and returns a validated analysis.
 *
 * Images are inlined as data URIs rather than uploaded first — they're small
 * (720px JPEGs), single-use, and already stored in Supabase, so a second
 * upload round trip to OpenAI would buy nothing.
 */
export async function analyzeFootage(
  args: AnalyzeArgs,
): Promise<AnalyzeResult> {
  const { frames, poses, clipDurationSeconds, discipline, userNotes } = args;

  if (frames.length === 0) {
    throw new Error("Cannot analyze a clip with no extracted frames.");
  }

  const imageParts = await Promise.all(
    frames.map(async (frame) => {
      const bytes = await readFile(frame.path);
      return [
        {
          type: "text" as const,
          text: `Frame ${frame.frameIndex} — t=${frame.timestampSeconds.toFixed(1)}s`,
        },
        {
          type: "image_url" as const,
          image_url: {
            url: `data:image/jpeg;base64,${bytes.toString("base64")}`,
            // "high" preserves the detail needed to read hand position and
            // foot placement; "low" downsamples to 512px and loses both.
            detail: "high" as const,
          },
        },
      ];
    }),
  );

  const contextLines = [
    `Clip duration: ${clipDurationSeconds !== null ? `${clipDurationSeconds.toFixed(1)}s` : "unknown"}`,
    `Frames supplied: ${frames.length}, sampled at ${config.framesPerSecond} fps`,
    discipline ? `Discipline: ${discipline}` : null,
    userNotes ? `Athlete's own notes: ${userNotes}` : null,
  ].filter(Boolean);

  const completion = await getClient().chat.completions.create({
    model: config.model,
    max_completion_tokens: 8_000,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: contextLines.join("\n") },
          ...imageParts.flat(),
          {
            type: "text",
            text:
              "Pose measurements for the frames above:\n\n" +
              formatPoseTable(frames, poses) +
              "\n\nAnalyze this athlete's stance, guard, footwork, and output " +
              "rate; identify their technical gaps; name the professional " +
              "whose style most closely matches and explain why; and prescribe " +
              "drills for the gaps you found.",
          },
        ],
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "fight_analysis",
        strict: true,
        schema: ANALYSIS_SCHEMA,
      },
    },
  });

  const choice = completion.choices[0];

  if (!choice) {
    throw new Error("The model returned no choices.");
  }

  // A refusal comes back as a populated `refusal` field with `content` null —
  // reading `content` first would just yield a confusing empty-response error.
  if (choice.message.refusal) {
    throw new RefusalError(choice.message.refusal);
  }

  if (choice.finish_reason === "length") {
    throw new Error(
      "Analysis was truncated before completing. Try a shorter clip or fewer frames.",
    );
  }

  const text = choice.message.content;
  if (!text?.trim()) {
    throw new Error("The model returned an empty response.");
  }

  let payload: AnalysisPayload;
  try {
    payload = JSON.parse(text) as AnalysisPayload;
  } catch (error) {
    throw new Error(
      `The model returned unparseable JSON despite the strict output schema: ${String(error)}`,
    );
  }

  return {
    payload,
    model: completion.model ?? config.model,
    framesAnalyzed: frames.length,
  };
}
