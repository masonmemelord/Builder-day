"use server";

import { revalidatePath } from "next/cache";
import { config } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

export interface TermsState {
  ok: boolean;
  error?: string;
}

/**
 * Records the current user's ToS acknowledgement.
 *
 * Stores the version rather than a boolean so bumping `config.termsVersion`
 * re-prompts everyone — a one-way flag would silently grandfather users onto
 * terms they never saw.
 */
export async function acceptTerms(): Promise<TermsState> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false, error: "You must be signed in to accept the terms." };
  }

  const { error } = await supabase
    .from("profiles")
    .update({
      terms_accepted_at: new Date().toISOString(),
      terms_version: config.termsVersion,
    })
    .eq("id", user.id);

  if (error) {
    return { ok: false, error: error.message };
  }

  revalidatePath("/upload");
  return { ok: true };
}

/** True when the signed-in user has accepted the *current* terms version. */
export async function hasAcceptedTerms(): Promise<boolean> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return false;

  const { data } = await supabase
    .from("profiles")
    .select("terms_accepted_at, terms_version")
    .eq("id", user.id)
    .maybeSingle();

  return Boolean(
    data?.terms_accepted_at && data.terms_version === config.termsVersion,
  );
}
