"use client";

import { createBrowserClient } from "@supabase/ssr";
import { publicEnv } from "@/lib/env";

/**
 * Browser Supabase client. Uses the anon key and is subject to RLS.
 *
 * `createBrowserClient` memoises internally, so calling this per-component is
 * cheap and does not open duplicate realtime connections.
 */
export function createClient() {
  return createBrowserClient(publicEnv.supabaseUrl, publicEnv.supabaseAnonKey);
}
