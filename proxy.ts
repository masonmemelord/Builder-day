import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

/**
 * Next.js 16 renamed the `middleware` convention to `proxy`. This runs on every
 * matched request to refresh the Supabase session cookie and gate private
 * routes — see lib/supabase/middleware.ts.
 */
export default async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Everything except static assets and the worker endpoint. The worker
     * authenticates with a bearer secret, not a cookie session, so running the
     * session refresh against it is pure overhead.
     */
    "/((?!_next/static|_next/image|favicon.ico|api/worker|.*\\.(?:svg|png|jpg|jpeg|gif|webp|mp4)$).*)",
  ],
};
