import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// Supabase client for use in Server Components, Server Actions, and
// Route Handlers (code that runs only on the server). Must be created
// fresh per request — never cache/reuse this across requests (Fluid
// compute can keep server instances warm and share module-level state
// across different users' requests).
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // setAll was called from a Server Component, which can't
            // write cookies. Safe to ignore here because the proxy
            // (proxy.ts) refreshes the session on every request.
          }
        },
      },
    },
  );
}
