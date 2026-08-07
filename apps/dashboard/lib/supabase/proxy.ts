import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Issue 2.4: reads the Supabase session on every request, transparently
// refreshing the access token when it's expired, and redirects
// unauthenticated requests away from protected /app/* routes to
// /sign-in. Called from proxy.ts (the Next.js 16 request boundary — the
// renamed successor to middleware.ts) on every matched request.
export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  // Create a new client per request rather than reusing one from module
  // scope — with Fluid compute, a warm server instance can be reused
  // across requests from different users, and a shared client would leak
  // one user's session into another's request.
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, headers) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
          Object.entries(headers).forEach(([key, value]) =>
            supabaseResponse.headers.set(key, value),
          );
        },
      },
    },
  );

  // Do not add code between createServerClient and getClaims(). Never
  // use getSession() here — it does not revalidate the JWT and can leave
  // users randomly signed out. getClaims() validates the JWT signature
  // against the project's published keys on every call, which is what
  // makes it safe to trust for route protection.
  const { data } = await supabase.auth.getClaims();
  const user = data?.claims;

  if (!user && request.nextUrl.pathname.startsWith("/app")) {
    const url = request.nextUrl.clone();
    url.pathname = "/sign-in";
    return NextResponse.redirect(url);
  }

  // Prevent CDN/edge caching from serving one user's refreshed session
  // cookie to a different user.
  supabaseResponse.headers.set("Cache-Control", "private, no-store");

  // Must return supabaseResponse as-is (or a new response carrying over
  // its cookies) — returning a differently-constructed response here can
  // desync the browser and server and terminate sessions prematurely.
  return supabaseResponse;
}
