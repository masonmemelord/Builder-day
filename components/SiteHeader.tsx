import Link from "next/link";
import { signOut } from "@/app/actions/auth";
import { createClient } from "@/lib/supabase/server";

export async function SiteHeader() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <header className="border-b border-border bg-surface">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-6 py-4">
        <Link href="/" className="flex items-center gap-2.5">
          <span
            aria-hidden
            className="block h-5 w-1.5 rounded-full bg-accent"
          />
          <span className="display text-xl tracking-wide">Fight IQ</span>
          <span className="rounded border border-border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted">
            Demo
          </span>
        </Link>

        <nav className="flex items-center gap-5 text-sm" aria-label="Main">
          {user ? (
            <>
              <Link
                href="/upload"
                className="text-muted transition-colors hover:text-foreground"
              >
                New analysis
              </Link>
              <Link
                href="/analyses"
                className="text-muted transition-colors hover:text-foreground"
              >
                My clips
              </Link>
              <form action={signOut}>
                <button
                  type="submit"
                  className="text-muted transition-colors hover:text-foreground"
                >
                  Sign out
                </button>
              </form>
            </>
          ) : (
            <>
              <Link
                href="/terms"
                className="text-muted transition-colors hover:text-foreground"
              >
                Terms
              </Link>
              <Link
                href="/login"
                className="text-muted transition-colors hover:text-foreground"
              >
                Sign in
              </Link>
              <Link
                href="/signup"
                className="rounded-md bg-accent px-3 py-1.5 font-medium text-white transition-opacity hover:opacity-90"
              >
                Get started
              </Link>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}
