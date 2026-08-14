import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { registerHealthRoute } from "./routes/health.js";
import { registerEventsRoute, type EventsRouteDeps } from "./routes/events.js";

export interface BuildAppDeps {
  /** Issue 6.2: real API-key auth needs real dependencies (a DB lookup),
   * so unlike issue 6.1's fully-stubbed version, buildApp() can no
   * longer construct usable defaults on its own -- the caller must
   * supply them. index.ts (the real server) wires
   * createSupabaseApiKeyAuthDeps() here; tests wire an in-memory fake
   * instead, so no test needs real Supabase credentials to exercise the
   * route. This is the one required argument buildApp() now has --
   * everything else about its shape from issue 6.1 (the optional
   * FastifyServerOptions override) is unchanged. */
  events: EventsRouteDeps;
}

/**
 * Builds (but does not start) the Fastify instance. Kept separate from
 * index.ts so tests can exercise routes via `.inject()` without binding
 * a real port — see src/routes/health.test.ts.
 *
 * `options` is an optional Fastify options override, merged over the
 * default `{ logger: true }` (added in issue 6.1 so events.test.ts can
 * point the logger at a captured stream to assert on the structured log
 * line).
 */
export function buildApp(
  deps: BuildAppDeps,
  options: FastifyServerOptions = {},
): FastifyInstance {
  const app = Fastify({
    logger: true,
    ...options,
  });

  registerHealthRoute(app);
  registerEventsRoute(app, deps.events);

  return app;
}
