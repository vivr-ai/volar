import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { registerHealthRoute } from "./routes/health.js";
import { registerEventsRoute } from "./routes/events.js";

/**
 * Builds (but does not start) the Fastify instance. Kept separate from
 * index.ts so tests can exercise routes via `.inject()` without binding
 * a real port — see src/routes/health.test.ts.
 *
 * Accepts an optional Fastify options override, merged over the default
 * `{ logger: true }`. Added in issue 6.1 so events.test.ts can point the
 * logger at a captured stream (to assert on the structured log line in
 * AC3) without every other caller needing to change — buildApp() with no
 * arguments still behaves exactly as before.
 */
export function buildApp(options: FastifyServerOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: true,
    ...options,
  });

  registerHealthRoute(app);
  registerEventsRoute(app);

  return app;
}
