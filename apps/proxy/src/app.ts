import Fastify, { type FastifyInstance } from "fastify";
import { registerHealthRoute } from "./routes/health.js";

/**
 * Builds (but does not start) the Fastify instance. Kept separate from
 * index.ts so tests can exercise routes via `.inject()` without binding
 * a real port — see src/routes/health.test.ts.
 */
export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: true,
  });

  registerHealthRoute(app);

  return app;
}
