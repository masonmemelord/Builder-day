"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

export interface AuthFormState {
  error?: string;
  notice?: string;
}

const credentialsSchema = z.object({
  email: z.string().trim().email("Enter a valid email address."),
  password: z.string().min(8, "Password must be at least 8 characters."),
});

/** Only allow same-origin relative paths — a raw `next` param is an open redirect. */
function safeRedirect(next: FormDataEntryValue | null): string {
  const value = typeof next === "string" ? next : "";
  return value.startsWith("/") && !value.startsWith("//") ? value : "/upload";
}

export async function signIn(
  _prevState: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const parsed = credentialsSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0].message };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);

  if (error) {
    // Don't distinguish "no such user" from "wrong password" — that difference
    // is an account-enumeration oracle.
    return { error: "Incorrect email or password." };
  }

  revalidatePath("/", "layout");
  redirect(safeRedirect(formData.get("next")));
}

export async function signUp(
  _prevState: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const parsed = credentialsSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0].message };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp(parsed.data);

  if (error) {
    return { error: error.message };
  }

  // With email confirmation enabled, signUp returns a user but no session.
  if (!data.session) {
    return {
      notice: "Check your email for a confirmation link, then sign in.",
    };
  }

  revalidatePath("/", "layout");
  redirect("/upload");
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  revalidatePath("/", "layout");
  redirect("/");
}
