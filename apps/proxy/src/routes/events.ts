import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  ingestionEventPayloadSchema,
  flattenIngestionPayloadErrors,
  type IngestionEventPayload,
} from "@volar/shared";
import {
  authenticateApiKey,
  type ApiKeyAuthResult,
  type AuthenticateApiKeyDeps,
} from "../auth/authenticate-api-key.js";
import type { ValidatedEventPayload } from "../ingestion/write-llm-call-event.js";

// Issue 6.1 (Epic 6 -- Ingestion API): POST /v1/events endpoint scaffold.
// Issue 6.2: real API-key auth middleware.
// Issue 6.3: real payload validation.
// Issue 6.4: batch support (this file's main handler, not a preHandler
// -- see below for why).
//
// Still deliberately incomplete beyond auth + validation -- no real
// write yet: 6.5/7.2/7.3 change the handler body to actually
// enqueue/write events via the 5.2 `writeLlmCallEvent` function, using
// request.validatedEvents below instead of re-deriving it.
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
//
// Two judgment calls for issue 6.4, both flagged here per the Working
// Agreement rather than decided silently:
//
// 1. Both a single event object AND an array of events are accepted.
//    FR-6.8 describes the SDK as *always* batching locally before
//    flushing (even a "batch" of one), so in production only the array
//    form will ever really be sent -- but issue 6.3's existing
//    single-object contract (and its tests/AC1's 400-on-invalid
//    behavior) isn't superseded by anything in 6.4's stated ACs, which
//    are explicitly about *batch* partial-failure handling. Keeping the
//    single-object path exactly as 6.3 left it (still 400 on an invalid
//    single payload, still `{status:"accepted"}` on a valid one) avoids
//    silently changing already-shipped, already-tested behavior for no
//    stated reason, while the array path gets the new
//    always-202-with-per-item-results semantics AC2 asks for. Detected
//    via `Array.isArray(request.body)`.
// 2. Validation therefore moved out of a preHandler (issue 6.3's
//    design) and into the main handler. A preHandler's job is
//    "short-circuit reject or continue" -- that fits 6.3's all-or-
//    nothing single payload, but not 6.4's AC2 ("partial-batch failure
//    ... does not fail the whole batch"), which needs to inspect every
//    item and build a per-item result set rather than stopping at the
//    first bad one. Auth stays a preHandler (still genuinely all-or-
//    nothing: one key authenticates the whole request, valid for every
//    item in a batch).

const API_KEY_HEADER = "x-api-key";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the auth preHandler once a request authenticates
     * successfully (issue 6.2). */
    apiKeyContext?: { apiKeyId: string; projectId: string };
    /** Set by the handler once the body's been validated (issue 6.3,
     * extended to arrays in 6.4) -- every successfully-validated event
     * from the request, single or batch, in original order. Future
     * issues (6.5/7.x real write) consume this directly instead of
     * re-deriving it. Rejected items are *not* included here -- see
     * the response body's `results` array (batch requests) or `error`
     * field (single requests) for those. */
    validatedEvents?: ValidatedEventPayload[];
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
      // AC3 (issue 6.2): "rejected immediately with a clear error". Safe
      // to be specific here -- reaching this branch requires the
      // presented key to have hash-matched a real row, i.e. the caller
      // genuinely holds (or held) that exact secret. See the
      // reason-field comment on ApiKeyAuthResult for the full argument.
      return "this API key has been revoked";
    case "grace_period_expired":
      return "this API key's rotation grace period has expired; use your current key";
    case "not_found":
    default:
      // AC4 (issue 6.2): deliberately generic -- covers both "no key
      // with this prefix exists" and "prefix exists but the secret
      // doesn't match" so a prober can't distinguish the two from the
      // response.
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

/**
 * Maps the validated wire payload (snake_case, per FR-6.5) onto
 * write-llm-call-event.ts's internal ValidatedEventPayload shape
 * (camelCase), resolving project_id from the *authenticated key*
 * (issue 6.2), never from the client body -- see
 * ingestion-event-payload.ts's comment for why accepting a
 * client-supplied project_id would be a cross-project write
 * vulnerability.
 */
function toValidatedEventPayload(
  payload: IngestionEventPayload,
  projectId: string,
): ValidatedEventPayload {
  return {
    eventId: payload.event_id,
    projectId,
    provider: payload.provider,
    model: payload.model,
    inputTokens: payload.input_tokens,
    outputTokens: payload.output_tokens,
    customerId: payload.customer_id ?? null,
    featureId: payload.feature_id ?? null,
    occurredAt: payload.timestamp,
    status: payload.status,
  };
}

type BatchItemResult =
  | { index: number; status: "accepted"; eventId: string }
  | {
      index: number;
      status: "rejected";
      error: string;
      fieldErrors: Record<string, string[] | undefined>;
      formErrors: string[];
    };

function validateItem(
  item: unknown,
  index: number,
  projectId: string,
): { result: BatchItemResult; validated: ValidatedEventPayload | null } {
  const parseResult = ingestionEventPayloadSchema.safeParse(item);

  if (!parseResult.success) {
    const { fieldErrors, formErrors } = flattenIngestionPayloadErrors(parseResult.error);
    return {
      result: { index, status: "rejected", error: "invalid event payload", fieldErrors, formErrors },
      validated: null,
    };
  }

  const validated = toValidatedEventPayload(parseResult.data, projectId);
  return {
    result: { index, status: "accepted", eventId: validated.eventId },
    validated,
  };
}

export function registerEventsRoute(app: FastifyInstance, deps: EventsRouteDeps): void {
  app.post(
    "/v1/events",
    { preHandler: makeApiKeyAuthPreHandler(deps.authApiKeyDeps) },
    async (request, reply) => {
      // Non-null assertion is safe: the preHandler above already
      // short-circuited with a 401 if auth didn't succeed.
      const projectId = request.apiKeyContext!.projectId;

      const isBatch = Array.isArray(request.body);
      const items: unknown[] = isBatch ? (request.body as unknown[]) : [request.body];

      // Edge case not covered by either issue's literal ACs, so this is
      // a judgment call: an explicitly-empty batch array (`[]`) has
      // nothing to process at all -- treated as a top-level 400 rather
      // than a vacuous "0 accepted, 0 rejected" 202, since the latter
      // would silently succeed a request that did nothing.
      if (isBatch && items.length === 0) {
        await reply.status(400).send({ error: "batch must contain at least one event" });
        return;
      }

      const validatedEvents: ValidatedEventPayload[] = [];
      const results: BatchItemResult[] = items.map((item, index) => {
        const { result, validated } = validateItem(item, index, projectId);
        if (validated) validatedEvents.push(validated);
        return result;
      });

      request.validatedEvents = validatedEvents;

      const acceptedCount = validatedEvents.length;
      const rejectedCount = results.length - acceptedCount;

      // AC3 (issue 6.1): basic request logging. Structured (not a bare
      // string) so it's greppable/queryable once real log aggregation
      // lands (Epic 19), and deliberately does not log the full request
      // body -- event payloads can carry customer-supplied metadata
      // (customer_id, feature_id) that shouldn't be duplicated into
      // logs beyond whatever Epic 19's observability work explicitly
      // decides to capture.
      request.log.info(
        {
          event: "ingestion_request_received",
          method: request.method,
          url: request.url,
          projectId,
          batch: isBatch,
          accepted: acceptedCount,
          rejected: rejectedCount,
        },
        "POST /v1/events accepted",
      );

      // AC1 (issue 6.3) / AC2 (issue 6.4): rejected item(s) always get a
      // clear, structured record -- a single summary log line covering
      // every rejected item in this request, rather than one line per
      // item (bounded by batch size in practice -- SDKs flush every
      // 2-5s per FR-6.8, not thousands of events at once -- but no
      // reason to spam the log stream per-item regardless).
      if (rejectedCount > 0) {
        request.log.warn(
          {
            event: "payload_rejected",
            batch: isBatch,
            rejectedCount,
            rejected: results.filter((r) => r.status === "rejected"),
          },
          isBatch
            ? "POST /v1/events rejected some events in the batch"
            : "POST /v1/events rejected a malformed payload",
        );
      }

      if (!isBatch) {
        // Unchanged from issue 6.3: a single request's one-and-only
        // event is all-or-nothing at the HTTP level.
        const only = results[0];
        if (only.status === "rejected") {
          return reply
            .status(400)
            .send({ error: only.error, fieldErrors: only.fieldErrors, formErrors: only.formErrors });
        }
        return reply.status(202).send({ status: "accepted" });
      }

      // AC2 (issue 6.4): "Partial-batch failure ... does not fail the
      // whole batch — bad events are rejected individually and reported
      // back." A batch request always reaches this 202 (the empty-array
      // case above is the only rejected batch shape), carrying each
      // item's own accepted/rejected outcome rather than collapsing the
      // whole request to a single pass/fail.
      return reply.status(202).send({ accepted: acceptedCount, rejected: rejectedCount, results });
    },
  );
}
