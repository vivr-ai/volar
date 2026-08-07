import { createBrowserClient } from "@supabase/ssr";

// Supabase client for use in Client Components (code that runs in the
// browser). createBrowserClient uses a singleton pattern internally, so
// calling this repeatedly is cheap — it does not create a new connection
// each time.
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
