import type { Metadata } from "next";
import Link from "next/link";
import { signIn } from "@/app/actions/auth";
import { AuthForm } from "@/components/AuthForm";

export const metadata: Metadata = { title: "Sign in — Fight IQ" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;

  return (
    <div className="mx-auto max-w-sm px-6 py-20">
      <h1 className="display mb-2 text-3xl">Sign in</h1>
      <p className="mb-8 text-sm text-muted">
        Fight IQ is a test tool. Please don&rsquo;t reuse a password you care
        about.
      </p>

      <AuthForm mode="signin" action={signIn} next={next} />

      <p className="mt-8 text-center text-xs text-muted">
        By using this tool you agree to the{" "}
        <Link href="/terms" className="underline underline-offset-4">
          Terms &amp; Disclaimer
        </Link>
        .
      </p>
    </div>
  );
}
