import type { Metadata } from "next";
import Link from "next/link";
import { signUp } from "@/app/actions/auth";
import { AuthForm } from "@/components/AuthForm";

export const metadata: Metadata = { title: "Create account — Fight IQ" };

export default function SignupPage() {
  return (
    <div className="mx-auto max-w-sm px-6 py-20">
      <h1 className="display mb-2 text-3xl">Create an account</h1>
      <p className="mb-8 text-sm text-muted">
        This is an experimental demo. Data may be deleted at any time — please
        don&rsquo;t reuse a password you care about.
      </p>

      <AuthForm mode="signup" action={signUp} />

      <p className="mt-8 text-center text-xs text-muted">
        By creating an account you agree to the{" "}
        <Link href="/terms" className="underline underline-offset-4">
          Terms &amp; Disclaimer
        </Link>
        .
      </p>
    </div>
  );
}
