import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

const PIPELINE = [
  {
    step: "01",
    title: "Ingest",
    body: "Upload a file or paste a YouTube link with an optional in/out point. Both paths land in the same place.",
  },
  {
    step: "02",
    title: "Extract",
    body: "ffmpeg pulls frames at 1 fps across the clip — enough to read technique without drowning in near-identical stills.",
  },
  {
    step: "03",
    title: "Pose",
    body: "MediaPipe estimates 33 body landmarks per frame, giving stance width, guard height, and torso rotation as numbers rather than impressions.",
  },
  {
    step: "04",
    title: "Analyze",
    body: "A vision model reads the frames and the pose measurements together, then reports stance, guard, footwork, output rate, gaps, and drills.",
  },
];

export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <div className="mx-auto max-w-4xl px-6">
      <section className="border-b border-border py-20 sm:py-28">
        <p className="mb-4 inline-block rounded-full border border-accent/40 bg-accent-soft px-3 py-1 text-xs font-medium uppercase tracking-[0.16em] text-accent">
          Not-for-profit proof of concept
        </p>

        <h1 className="display max-w-2xl text-5xl leading-[0.95] sm:text-7xl">
          Film study,
          <br />
          without the film room.
        </h1>

        <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted">
          Upload sparring footage and get a technical breakdown: stance, guard,
          footwork, output rate, the professional whose style you most resemble,
          and the drills that close your gaps.
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-4">
          <Link
            href={user ? "/upload" : "/signup"}
            className="rounded-md bg-accent px-5 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90"
          >
            {user ? "Analyze a clip" : "Try the demo"}
          </Link>
          <Link
            href="/terms"
            className="text-sm text-muted underline underline-offset-4 transition-colors hover:text-foreground"
          >
            Read the disclaimer first
          </Link>
        </div>

        <p className="mt-8 max-w-xl text-sm leading-relaxed text-muted">
          <span className="text-foreground">Before you start:</span> this is an
          experiment, not a product. The analysis is AI-generated, frequently
          imperfect, and is not coaching or medical advice. Nothing here is for
          sale.
        </p>
      </section>

      <section className="py-16">
        <h2 className="display mb-8 text-2xl">How it works</h2>
        <ol className="grid gap-5 sm:grid-cols-2">
          {PIPELINE.map((item) => (
            <li
              key={item.step}
              className="rounded-lg border border-border bg-surface p-6"
            >
              <p className="display mb-2 text-sm text-accent">{item.step}</p>
              <h3 className="display mb-2 text-xl text-foreground">
                {item.title}
              </h3>
              <p className="text-sm leading-relaxed text-muted">{item.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="border-t border-border py-16">
        <h2 className="display mb-4 text-2xl">What it can&rsquo;t do</h2>
        <ul className="max-w-2xl space-y-3 text-[15px] leading-relaxed text-muted">
          <li className="flex gap-3">
            <span aria-hidden className="text-accent">
              —
            </span>
            <span>
              It reads sampled frames, not continuous video. Strikes that happen
              between samples are invisible to it, so output-rate figures are
              estimates at best.
            </span>
          </li>
          <li className="flex gap-3">
            <span aria-hidden className="text-accent">
              —
            </span>
            <span>
              It can misread technique and state wrong conclusions confidently.
              Two runs on the same clip may disagree.
            </span>
          </li>
          <li className="flex gap-3">
            <span aria-hidden className="text-accent">
              —
            </span>
            <span>
              It cannot see intent, fatigue, injury, or anything outside the
              frame — and it must not be used to make decisions about training
              through pain.
            </span>
          </li>
          <li className="flex gap-3">
            <span aria-hidden className="text-accent">
              —
            </span>
            <span>
              It is not a replacement for a coach. If the tool and your coach
              disagree, your coach is right.
            </span>
          </li>
        </ul>
      </section>
    </div>
  );
}
