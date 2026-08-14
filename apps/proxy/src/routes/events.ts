import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  authenticateApiKey,
  type ApiKeyAuthResult,
  type AuthenticateApiKeyDeps,
} from "../auth/authenticate-api-key.js";

// Issue 6.1 (Epic 6 -- Ingestion API): POST /v1/events endpoint scaffold.
// Issue 6.2: real API-key auth middleware (this file's preHandler).
//
// Still deliberately incomplete beyond auth -- no payload validation and
// no real write yet:
//   - 6.3 adds real payload validation (a zod schema per PRD FR-6.5,
//     shared so SDK integration tests can assert against the same
//     contract). Not attempted here -- a half-validation ad hoc check
//     now would just be thrown away when 6.3 lands with the real schema
//     and its own 400-with-clear-error-body AC.
//   - 6.4 changes the handler to accept an array (batch) of events.
//   - 6.5/7.2/7.3 change the handler body to actually enqueue/write the
//     event via the 5.2 `writeLlmCallEvent` function instead of just
//     logging and acking.
//
// Header choice for issue 6.2: the PRD (FR-6.5) says the SDK sends "...
// project API key" as one of the event fields but doesn't specify HTTP
// transport; the backlog's 6.1 description does commit to "auth'd via
// API key header", so header transport itself isn't open -- only the
// header *name* was. Chosen: `x-api-key`, matching the convention of
// the exact APIs this product wraps (Anthropic's Messages API uses the
// same header name) rather than `Authorization: Bearer`, so it reads as
// familiar to Volar's own target developer. This is a judgment call on
// a genuinely open point, flagged here rather than decided silently --
// revisit if the SDK packages (Epic 9/10) want something else.

const API_KEY_HEADER = "x-api-key";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the auth preHandler once a request authenticates
     * successfully (issue 6.2). Future issues (6.4 batch, 6.5/7.x real
     * write) read this instead of re-deriving project_id themselves. */
    apiKeyContext?: { apiKeyId: string; projectId: string };
  }
}

export interface EventsRouteDeps {
  authApiKeyDeps: AuthenticateApiKeyDeps;
}

function authFailureMessage(
  reason: Extract<ApiKeyAuthResult, { authenticated: false }>["reason"],
): string {
  switch (reason) {
    case "revoked":
      // AC3: "rejected immediately with a clear error". Safe to be
      // specific here -- reaching this branch requires the presented
      // key to have hash-matched a real row, i.e. the caller genuinely
      // holds (or held) that exact secret. See the reason-field comment
      // on ApiKeyAuthResult for the full argument.
      return "this API key has been revoked";
    case "grace_period_expired":
      return "this API key's rotation grace period has expired; use your current key";
    case "not_found":
    default:
      // AC4: deliberately generic -- covers both "no key with this
      // prefix exists" and "prefix exists but the secret doesn't match"
      // so a prober can't distinguish the two from the response.
      return "invalid API key";
  }
}

function makeApiKeyAuthPreHandler(authDeps: AuthenticateApiKeyDeps) {
  return async function apiKeyAuthPreHandler(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const header = request.headers[API_KEY_HEADER];
    const presentedKey = Array.isArray(header) ? header[0] : header;

    if (!presentedKey) {
      request.log.warn(
        { event: "auth_rejected", reason: "missing_header" },
        `POST /v1/events missing ${API_KEY_HEADER} header`,
      );
      await reply.status(401).send({ error: "missing API key" });
      return;
    }

    const result = await authenticateApiKey(authDeps, presentedKey);

    if (!result.authenticated) {
      request.log.warn(
        { event: "auth_rejected", reason: result.reason },
        "POST /v1/events rejected an API key",
      );
      await reply.status(401).send({ error: authFailureMessage(result.reason) });
      return;
    }

    request.apiKeyContext = { apiKeyId: result.apiKeyId, projectId: result.projectId };
  };
}

export function registerEventsRoute(app: FastifyInstance, deps: EventsRouteDeps): void {
  app.post(
    "/v1/events",
    { preHandler: makeApiKeyAuthPreHandler(deps.authApiKeyDeps) },
    async (request, reply) => {
      // AC3 (issue 6.1): basic request logging. Structured (not a bare
      // string) so it's greppable/queryable once real log aggregation
      // lands (Epic 19), and deliberately does not log the request body
      // -- event payloads can carry customer-supplied metadata
      // (customer_id, feature_id) that shouldn't be duplicated into
      // logs beyond whatever Epic 19's observability work explicitly
      // decides to capture.
      request.log.info(
        {
          event: "ingestion_request_received",
          method: request.method,
          url: request.url,
          projectId: request.apiKeyContext?.projectId,
        },
        "POST /v1/events accepted",
      );

      return reply.status(202).send({ status: "accepted" });
    },
  );
}
