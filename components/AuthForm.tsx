"use client";

import Link from "next/link";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import type { AuthFormState } from "@/app/actions/auth";

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-md bg-accent px-4 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? "Working…" : label}
    </button>
  );
}

export function AuthForm({
  mode,
  action,
  next,
}: {
  mode: "signin" | "signup";
  action: (state: AuthFormState, formData: FormData) => Promise<AuthFormState>;
  next?: string;
}) {
  const [state, formAction] = useActionState<AuthFormState, FormData>(action, {});
  const isSignUp = mode === "signup";

  return (
    <form action={formAction} className="space-y-4">
      {next ? <input type="hidden" name="next" value={next} /> : null}

      <div>
        <label
          htmlFor="email"
          className="mb-1.5 block text-sm font-medium text-foreground"
        >
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted"
          placeholder="you@example.com"
        />
      </div>

      <div>
        <label
          htmlFor="password"
          className="mb-1.5 block text-sm font-medium text-foreground"
        >
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete={isSignUp ? "new-password" : "current-password"}
          required
          minLength={8}
          className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted"
          placeholder={isSignUp ? "At least 8 characters" : "••••••••"}
        />
      </div>

      {state.error ? (
        <p
          role="alert"
          className="rounded-md border border-accent/40 bg-accent-soft px-3 py-2 text-sm text-foreground"
        >
          {state.error}
        </p>
      ) : null}

      {state.notice ? (
        <p
          role="status"
          className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground"
        >
          {state.notice}
        </p>
      ) : null}

      <SubmitButton label={isSignUp ? "Create account" : "Sign in"} />

      <p className="pt-1 text-center text-sm text-muted">
        {isSignUp ? (
          <>
            Already have an account?{" "}
            <Link
              href="/login"
              className="text-foreground underline underline-offset-4"
            >
              Sign in
            </Link>
          </>
        ) : (
          <>
            No account?{" "}
            <Link
              href="/signup"
              className="text-foreground underline underline-offset-4"
            >
              Create one
            </Link>
          </>
        )}
      </p>
    </form>
  );
}
