import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";

// Next.js 16 renamed middleware.ts to proxy.ts (same request-boundary
// concept — runs before every matched request, on the Node.js runtime).
// See https://nextjs.org/blog/next-16 and docs/AUTH.md for context.
export async function proxy(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico
     * - common static image extensions
     * Keeping the proxy off these paths avoids doing a Supabase session
     * check on requests that never need one.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
