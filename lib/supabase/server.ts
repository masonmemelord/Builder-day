import { createServerClient } from "@supabase/ssr";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { publicEnv, serverEnv } from "@/lib/env";

/**
 * Request-scoped Supabase client for Server Components, Server Actions, and
 * Route Handlers. Reads the session from cookies and is subject to RLS.
 *
 * Must be created per request — never hoisted to a module-level singleton, or
 * one user's session leaks into another's request.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(publicEnv.supabaseUrl, publicEnv.supabaseAnonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Components cannot set cookies. The middleware refreshes the
          // session on every request, so ignoring this is safe.
        }
      },
    },
  });
}

/**
 * Service-role client. Bypasses RLS entirely — only ever construct this inside
 * the worker or a route handler that has already authorised the caller.
 *
 * Never import this from a Client Component: `serverEnv` throws in the browser,
 * but keep the boundary explicit anyway.
 */
export function createAdminClient() {
  return createSupabaseClient(
    publicEnv.supabaseUrl,
    serverEnv.supabaseServiceRoleKey,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    },
  );
}
