import type { FastifyInstance } from "fastify";

// Issue 6.1 (Epic 6 -- Ingestion API): POST /v1/events endpoint scaffold.
//
// This is deliberately just a scaffold. It stands up the route and the
// two extension points the rest of Epic 6 hooks into, but does not yet
// perform real auth, real payload validation, or a real write. That's
// intentional, per this issue's own acceptance criteria ("stubbed auth
// for now") and description ("auth logic itself is 6.2") -- not an
// oversight:
//
//   - 6.2 replaces `stubbedApiKeyAuth` below with the real APIKey
//     hash-lookup + 24h rotation-grace-period + revocation check. The
//     route registration doesn't need to change when that happens --
//     6.2's job is entirely inside that one function.
//   - 6.3 adds real payload validation (a zod schema per PRD FR-6.5,
//     shared so SDK integration tests can assert against the same
//     contract) in place of this issue's total absence of shape
//     checking. Deliberately not attempted here -- a half-validation
//     ad hoc check now would just be thrown away when 6.3 lands with
//     the real schema and its own 400-with-clear-error-body AC.
//   - 6.4 changes the handler to accept an array (batch) of events.
//   - 6.5/7.2/7.3 change the handler body to actually enqueue/write the
//     event via the 5.2 `writeLlmCallEvent` function instead of just
//     logging and acking.
//
// Issue 6.1's own stated acceptance criteria (see build_backlog.py,
// epic 6, issue 1) are: the route exists and returns 202 on a
// well-formed request with auth stubbed (AC1); it responds within the
// PRD NFR §10.2 latency budget even under this stub (AC2); and basic
// request logging is in place (AC3). See events.test.ts for how each is
// verified.

/**
 * Placeholder for issue 6.2's real API-key auth middleware. Intentionally
 * a no-op today -- every request reaches the handler below unauthenticated
 * -- so this route is usable end-to-end before 6.2 lands. 6.2 replaces the
 * body of this function with the real hash-lookup / grace-period /
 * revocation logic against `public.api_keys` (issue 3.3's table); nothing
 * else in this file should need to change.
 *
 * Takes no parameters (rather than declared-but-unused `request`/`reply`
 * params) since it doesn't inspect the request yet -- a function with
 * fewer parameters than Fastify's preHandler hook type expects is a
 * valid, fully type-safe substitute in TypeScript, and it keeps this repo's
 * shared `@typescript-eslint/no-unused-vars` (no underscore-prefix
 * exemption configured -- see packages/config/eslint/base.mjs) happy
 * without an eslint-disable comment. 6.2 adds real `request`/`reply`
 * params back when it needs them.
 */
async function stubbedApiKeyAuth(): Promise<void> {
  // Intentionally empty -- see doc comment above and issue 6.2.
}

export function registerEventsRoute(app: FastifyInstance): void {
  app.post(
    "/v1/events",
    { preHandler: stubbedApiKeyAuth },
    async (request, reply) => {
      // AC3: basic request logging. Structured (not a bare string) so
      // it's greppable/queryable once real log aggregation lands (Epic
      // 19), and deliberately does not log the request body -- event
      // payloads can carry customer-supplied metadata (customer_id,
      // feature_id) that shouldn't be duplicated into logs beyond
      // whatever Epic 19's observability work explicitly decides to
      // capture.
      request.log.info(
        {
          event: "ingestion_request_received",
          method: request.method,
          url: request.url,
        },
        "POST /v1/events accepted",
      );

      return reply.status(202).send({ status: "accepted" });
    },
  );
}
