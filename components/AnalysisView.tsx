import type { Analysis, Video } from "@/lib/types";

function Card({
  label,
  headline,
  children,
}: {
  label: string;
  headline: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface p-5">
      <p className="mb-1 text-xs font-medium uppercase tracking-[0.14em] text-muted">
        {label}
      </p>
      <p className="display mb-3 text-2xl leading-tight text-foreground">
        {headline}
      </p>
      <div className="space-y-2 text-sm leading-relaxed text-muted">
        {children}
      </div>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <p>
      <span className="text-foreground">{label}:</span> {value}
    </p>
  );
}

const SEVERITY_STYLES: Record<string, string> = {
  significant: "border-accent/50 text-accent",
  moderate: "border-signal/50 text-signal",
  minor: "border-border text-muted",
};

export function AnalysisView({
  analysis,
  video,
}: {
  analysis: Analysis;
  video: Video;
}) {
  const { stance, guard, footwork, output_rate: output } = analysis;
  const pro = analysis.pro_comparison;

  return (
    <div className="space-y-10">
      {/* Summary */}
      <section>
        <h2 className="display mb-3 text-xl">The read</h2>
        <p className="text-[17px] leading-relaxed text-foreground">
          {analysis.summary}
        </p>
      </section>

      {/* Four core dimensions */}
      <section>
        <h2 className="display mb-4 text-xl">Breakdown</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Card label="Stance" headline={stance.orthodox_or_southpaw}>
            <Meta label="Width" value={stance.width} />
            <Meta label="Weight" value={stance.weight_distribution} />
            <p className="pt-1">{stance.observations}</p>
          </Card>

          <Card label="Guard" headline={guard.height}>
            <Meta label="Style" value={guard.style} />
            <Meta label="Hand return" value={guard.hand_return_speed} />
            <p className="pt-1">{guard.observations}</p>
          </Card>

          <Card label="Footwork" headline={footwork.mobility}>
            {footwork.patterns.length > 0 ? (
              <ul className="list-inside list-disc space-y-1">
                {footwork.patterns.map((pattern) => (
                  <li key={pattern}>{pattern}</li>
                ))}
              </ul>
            ) : null}
            <p className="pt-1">{footwork.observations}</p>
          </Card>

          <Card label="Output rate" headline={output.volume}>
            <Meta
              label="Est. strikes/min"
              value={
                output.estimated_strikes_per_minute !== null
                  ? String(output.estimated_strikes_per_minute)
                  : "not estimable from this sampling"
              }
            />
            <Meta label="Tendency" value={output.pressure_vs_counter} />
            <p className="pt-1">{output.observations}</p>
          </Card>
        </div>
      </section>

      {/* Pro comparison */}
      <section>
        <h2 className="display mb-4 text-xl">Closest professional style</h2>
        <div className="rounded-lg border border-accent/30 bg-accent-soft p-6">
          <div className="mb-4 flex flex-wrap items-baseline gap-3">
            <p className="display text-3xl leading-none text-foreground">
              {pro.fighter}
            </p>
            <span className="text-sm text-muted">{pro.discipline}</span>
            <span className="rounded-full border border-border px-2.5 py-0.5 text-xs text-muted">
              {pro.confidence} confidence
            </span>
          </div>

          <p className="mb-5 text-[15px] leading-relaxed text-foreground">
            {pro.reasoning}
          </p>

          <div className="grid gap-5 sm:grid-cols-2">
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-[0.14em] text-muted">
                What matches
              </p>
              <ul className="space-y-1.5 text-sm text-foreground">
                {pro.shared_traits.map((trait) => (
                  <li key={trait} className="flex gap-2">
                    <span aria-hidden className="text-success">
                      +
                    </span>
                    <span>{trait}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-[0.14em] text-muted">
                Where it breaks down
              </p>
              <ul className="space-y-1.5 text-sm text-foreground">
                {pro.key_differences.map((difference) => (
                  <li key={difference} className="flex gap-2">
                    <span aria-hidden className="text-accent">
                      −
                    </span>
                    <span>{difference}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* Technical gaps */}
      {analysis.technical_gaps.length > 0 ? (
        <section>
          <h2 className="display mb-4 text-xl">Technical gaps</h2>
          <ul className="space-y-3">
            {analysis.technical_gaps.map((gap) => (
              <li
                key={gap.area}
                className="rounded-lg border border-border bg-surface p-5"
              >
                <div className="mb-2 flex flex-wrap items-center gap-3">
                  <h3 className="font-medium text-foreground">{gap.area}</h3>
                  <span
                    className={`rounded-full border px-2.5 py-0.5 text-xs ${
                      SEVERITY_STYLES[gap.severity] ?? SEVERITY_STYLES.minor
                    }`}
                  >
                    {gap.severity}
                  </span>
                </div>
                <p className="text-sm leading-relaxed text-muted">
                  {gap.description}
                </p>
                {gap.frame_references.length > 0 ? (
                  <p className="mt-2 font-mono text-xs text-muted">
                    frames: {gap.frame_references.join(", ")}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Drills */}
      {analysis.drills.length > 0 ? (
        <section>
          <h2 className="display mb-1 text-xl">Suggested drills</h2>
          <p className="mb-4 text-sm text-muted">
            AI-generated suggestions, not a prescribed programme. Run them past
            a coach before adding them to your training.
          </p>
          <ul className="space-y-3">
            {analysis.drills.map((drill) => (
              <li
                key={drill.name}
                className="rounded-lg border border-border bg-surface p-5"
              >
                <div className="mb-2 flex flex-wrap items-baseline justify-between gap-3">
                  <h3 className="font-medium text-foreground">{drill.name}</h3>
                  <span className="font-mono text-xs text-signal">
                    {drill.sets_and_reps}
                  </span>
                </div>
                <p className="mb-2 text-sm leading-relaxed text-muted">
                  {drill.description}
                </p>
                <p className="text-xs text-muted">
                  <span className="text-foreground">Targets:</span>{" "}
                  {drill.targets}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Provenance — makes the limits of the result legible. */}
      <section className="border-t border-border pt-6">
        <dl className="grid gap-3 text-xs text-muted sm:grid-cols-3">
          <div>
            <dt className="mb-0.5 uppercase tracking-[0.14em]">Model</dt>
            <dd className="font-mono text-foreground">{analysis.model}</dd>
          </div>
          <div>
            <dt className="mb-0.5 uppercase tracking-[0.14em]">Frames read</dt>
            <dd className="font-mono text-foreground">
              {analysis.frames_analyzed}
            </dd>
          </div>
          <div>
            <dt className="mb-0.5 uppercase tracking-[0.14em]">Source</dt>
            <dd className="font-mono text-foreground">
              {video.source}
              {video.duration_seconds
                ? ` · ${video.duration_seconds.toFixed(0)}s`
                : ""}
            </dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
