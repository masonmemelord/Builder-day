"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { acceptTerms } from "@/app/actions/terms";

/**
 * First-upload ToS acknowledgement.
 *
 * Shown once per terms version — returning users who have already accepted the
 * current version never see it. This is a convenience gate; the API route
 * enforces the same check server-side, so dismissing this in devtools gets you
 * a 403 rather than an upload.
 */
export function TermsGate({ onAccepted }: { onAccepted: () => void }) {
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const dialogRef = useRef<HTMLDivElement>(null);
  const checkboxRef = useRef<HTMLInputElement>(null);

  // Move focus into the dialog on mount so keyboard and screen-reader users
  // land on the acknowledgement rather than staying behind the overlay.
  useEffect(() => {
    checkboxRef.current?.focus();
  }, []);

  // Trap Escape so the gate can't be dismissed without a decision.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") event.preventDefault();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  function handleAccept() {
    if (!checked) {
      setError("Please tick the box to confirm you've read the terms.");
      return;
    }
    setError(null);

    startTransition(async () => {
      const result = await acceptTerms();
      if (result.ok) {
        onAccepted();
      } else {
        setError(result.error ?? "Could not record your acceptance.");
      }
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="terms-gate-title"
    >
      <div
        ref={dialogRef}
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg border border-border bg-surface p-6 shadow-xl"
      >
        <h2 id="terms-gate-title" className="display mb-1 text-2xl">
          Before your first upload
        </h2>
        <p className="mb-5 text-sm text-muted">
          One-time acknowledgement. You won&rsquo;t see this again.
        </p>

        <ul className="mb-5 space-y-3 text-sm leading-relaxed text-foreground">
          <li className="flex gap-3">
            <span aria-hidden className="mt-0.5 text-accent">
              —
            </span>
            <span>
              Fight IQ is an <strong>experimental test tool</strong>, not a
              commercial product. It is not offered for profit and no payment is
              ever involved.
            </span>
          </li>
          <li className="flex gap-3">
            <span aria-hidden className="mt-0.5 text-accent">
              —
            </span>
            <span>
              The analysis is AI-generated, comes with{" "}
              <strong>no warranty of accuracy</strong>, and is{" "}
              <strong>not professional coaching or medical advice</strong>.
              Consult a qualified coach or medical professional for real
              training decisions.
            </span>
          </li>
          <li className="flex gap-3">
            <span aria-hidden className="mt-0.5 text-accent">
              —
            </span>
            <span>
              Only upload footage you <strong>own or have the right to use</strong>.
              YouTube links are processed transiently to produce your own
              result, and are never redistributed or repurposed.
            </span>
          </li>
          <li className="flex gap-3">
            <span aria-hidden className="mt-0.5 text-accent">
              —
            </span>
            <span>
              This is a test environment. It may change, go offline, or have{" "}
              <strong>data deleted at any time without notice</strong>.
            </span>
          </li>
        </ul>

        <label className="mb-4 flex cursor-pointer items-start gap-3 rounded-md border border-border bg-surface-raised p-3.5 text-sm">
          <input
            ref={checkboxRef}
            type="checkbox"
            checked={checked}
            onChange={(event) => setChecked(event.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]"
          />
          <span className="text-foreground">
            I&rsquo;ve read and agree to the{" "}
            <Link
              href="/terms"
              target="_blank"
              className="underline underline-offset-4"
            >
              Terms &amp; Disclaimer
            </Link>
            , and I understand this is a not-for-profit test tool that does not
            provide coaching or medical advice.
          </span>
        </label>

        {error ? (
          <p
            role="alert"
            className="mb-4 rounded-md border border-accent/40 bg-accent-soft px-3 py-2 text-sm text-foreground"
          >
            {error}
          </p>
        ) : null}

        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={handleAccept}
            disabled={pending || !checked}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? "Saving…" : "I understand — continue"}
          </button>
          <Link
            href="/"
            className="rounded-md border border-border px-4 py-2 text-sm text-muted transition-colors hover:text-foreground"
          >
            Leave
          </Link>
        </div>
      </div>
    </div>
  );
}
