import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { publicEnv } from "@/lib/env";

/** Routes reachable without a session. Everything else redirects to /login. */
const PUBLIC_PATHS = ["/", "/login", "/signup", "/terms", "/auth"];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

/**
 * Refreshes the Supabase session on every request and gates private routes.
 *
 * The response object returned here carries the refreshed auth cookies, so it
 * must be the one the middleware returns — building a fresh NextResponse
 * afterwards silently drops the refreshed session and logs the user out.
 */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    publicEnv.supabaseUrl,
    publicEnv.supabaseAnonKey,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // getUser() revalidates the token against Supabase. getSession() only reads
  // the cookie, which is spoofable — do not swap this out.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  // API routes do their own auth and answer with JSON. Redirecting them to the
  // login page would hand an API client an HTML document and a 307 where it
  // expects a 401.
  if (pathname.startsWith("/api/")) {
    return response;
  }

  if (!user && !isPublic(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  if (user && (pathname === "/login" || pathname === "/signup")) {
    const url = request.nextUrl.clone();
    url.pathname = "/upload";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return response;
}
