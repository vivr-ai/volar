import { z } from "zod";

// Issue 6.3 (Epic 6): shared ingestion event-payload contract.
//
// This is the wire contract for POST /v1/events' JSON body -- the exact
// fields the SDK sends per PRD FR-6.5 ("provider, model, input_tokens,
// output_tokens, timestamp, customer_id, feature_id, project API key")
// and §7's LLMCallEvent field list, minus the two fields that
// deliberately travel *outside* the body:
//
//   - the project API key: FR-6.5 lists it as something "the SDK
//     sends", but issue 6.1's description commits to "auth'd via API
//     key header" and issue 6.2 implements exactly that (the
//     `x-api-key` header) -- so it's never a body field here.
//   - project_id: not in FR-6.5's list at all, and deliberately kept
//     out of this schema even though apps/proxy's internal
//     ValidatedEventPayload (issue 5.2) has one. It's resolved
//     server-side from the authenticated API key (issue 6.2's
//     request.apiKeyContext.projectId), never accepted from the
//     client -- accepting a client-supplied project_id would let any
//     valid key for Project A write events into Project B just by
//     naming a different id in the body.
//
// Field names are snake_case, matching FR-6.5's own prose and §7's
// LLMCallEvent column names exactly (input_tokens, output_tokens,
// customer_id, feature_id) -- this *is* the wire contract, so it reads
// the same as the spec that defines it rather than getting silently
// translated to camelCase before anyone outside this codebase sees it.
// apps/proxy maps this shape to its internal camelCase
// ValidatedEventPayload at the HTTP boundary (see routes/events.ts).
//
// Two fields exist in the DB/logic layer but aren't in FR-6.5's literal
// sentence -- both already required elsewhere, not invented here:
//   - status: PRD §7's LLMCallEvent table explicitly lists
//     `status enum(success, error)`, "captures provider-side call
//     errors if the SDK chooses to report them."
//   - event_id: issue 5.4's client-generated idempotency key --
//     `event_id uuid not null unique` at the DB level. The SDK must
//     send one so retried delivery of the same real LLM call dedupes
//     correctly.
//
// event_id uses z.guid() rather than z.uuid(): z.uuid() enforces the
// RFC 4122 version/variant nibbles, which Postgres's own `uuid` column
// type does *not* -- Postgres accepts any properly-shaped 8-4-4-4-12
// hex string. z.guid() matches that same, more permissive shape check,
// which is what the actual DB constraint requires and is also what
// every test fixture elsewhere in this codebase already assumes (e.g.
// "11111111-aaaa-aaaa-aaaa-111111111111" -- not RFC-version-compliant,
// but a perfectly valid Postgres uuid).
//
// Unknown extra fields are silently stripped (zod object's default
// "strip" mode), not rejected -- a future SDK minor version adding a
// new optional field should never break an older, not-yet-redeployed
// proxy.
//
// AC3 ("Validation schema shared/exported so SDK integration tests can
// assert against the same contract"): lives in packages/shared
// specifically so the future Python/Node SDK packages (Epic 9/10) --
// and their integration tests -- import this exact schema instead of
// each independently re-guessing the contract from prose.

export const SUPPORTED_INGESTION_PROVIDERS = ["openai", "anthropic"] as const;

export const ingestionEventPayloadSchema = z.object({
  event_id: z.guid({ message: "event_id must be a valid UUID" }),
  provider: z.enum(SUPPORTED_INGESTION_PROVIDERS),
  model: z.string().min(1, "model must not be empty"),
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  timestamp: z.iso.datetime({
    offset: true,
    message: "timestamp must be an ISO 8601 datetime string",
  }),
  customer_id: z.string().min(1).nullable().optional(),
  feature_id: z.string().min(1).nullable().optional(),
  status: z.enum(["success", "error"]),
});

export type IngestionEventPayload = z.infer<typeof ingestionEventPayloadSchema>;

/**
 * Formats a failed parse's ZodError into a plain, JSON-serializable
 * shape suitable for a 400 response body (issue 6.3 AC1: "rejected with
 * a 400 and a clear error body"). Exported so consumers (apps/proxy)
 * never need their own direct dependency on zod just to read a rejected
 * parse's errors -- the same encapsulation already used for this
 * package's other implementation-detail dependencies (e.g. decimal.js
 * in compute-cost.ts is never exposed to callers either).
 */
export function flattenIngestionPayloadErrors(
  error: z.ZodError,
): { fieldErrors: Record<string, string[] | undefined>; formErrors: string[] } {
  return z.flattenError(error);
}
