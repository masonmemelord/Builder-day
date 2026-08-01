import Link from "next/link";

/**
 * Global footer.
 *
 * The one-line disclaimer here is a hard requirement of the project framing:
 * it appears on every page of the app UI, not only on /terms.
 */
export function Footer() {
  return (
    <footer className="mt-auto border-t border-border bg-surface">
      <div className="mx-auto flex max-w-5xl flex-col gap-3 px-6 py-6 text-sm sm:flex-row sm:items-center sm:justify-between">
        <p className="text-muted">
          <span className="font-medium text-foreground">
            Test tool only — not for profit, not professional advice.
          </span>{" "}
          AI-generated analysis for exploration, not coaching.
        </p>

        <nav className="flex items-center gap-4" aria-label="Footer">
          <Link
            href="/terms"
            className="text-muted underline underline-offset-4 transition-colors hover:text-foreground"
          >
            Terms &amp; Disclaimer
          </Link>
          <span aria-hidden className="text-border">
            /
          </span>
          <span className="text-muted">Fight IQ · proof of concept</span>
        </nav>
      </div>
    </footer>
  );
}
