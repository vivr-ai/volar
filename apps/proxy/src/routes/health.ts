import type { FastifyInstance } from "fastify";

/**
 * GET /health — liveness/readiness check for the proxy service.
 *
 * This is the one endpoint that must exist before anything else in the
 * proxy: issue 1.8 (Fly.io/Railway deploy) checks this route to confirm
 * the service came up, and Epic 19 (Observability) builds on the same
 * shape for internal monitoring.
 */
export function registerHealthRoute(app: FastifyInstance): void {
  app.get("/health", async () => {
    return {
      status: "ok",
      service: "volar-proxy",
      uptime_seconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  });
}
