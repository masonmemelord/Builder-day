import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { hasAcceptedTerms } from "@/app/actions/terms";
import { UploadForm } from "@/components/UploadForm";
import { config } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "New analysis — Fight IQ" };

export default async function UploadPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Middleware already gates this route; this is the belt-and-braces check that
  // makes `user` non-null for TypeScript and survives a middleware misconfig.
  if (!user) redirect("/login?next=/upload");

  const termsAccepted = await hasAcceptedTerms();

  return (
    <div className="mx-auto max-w-2xl px-6 py-14">
      <header className="mb-10">
        <p className="mb-2 text-xs font-medium uppercase tracking-[0.18em] text-accent">
          New analysis
        </p>
        <h1 className="display text-4xl leading-tight">Break down a clip</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-muted">
          Upload sparring, pad work, or a bout. Frames are sampled at{" "}
          {config.framesPerSecond} fps, run through pose estimation, and read by
          a vision model for stance, guard, footwork, and output rate.
        </p>
      </header>

      <UploadForm
        userId={user.id}
        termsAccepted={termsAccepted}
        maxUploadBytes={config.maxUploadBytes}
        maxClipSeconds={config.maxClipSeconds}
      />
    </div>
  );
}
