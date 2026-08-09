import { computeCostUsd, resolvePriceForEvent, type PriceTableRow } from "@volar/shared";

// Issue 5.2 (Epic 5): server-side event-write function.
// Issue 5.3 (Epic 5): null-cost handling + internal alert stub.
// Issue 5.4 (Epic 5): idempotency -- dedupe by client-generated event_id.
//
// Takes an already-validated incoming event payload (validation itself
// is issue 6.3's job -- this function assumes its input is well-formed)
// and performs the steps every ingested event needs: resolve the
// PriceTable version in effect at the time of the call (issue 4.4),
// compute the cost from it (issue 4.3), and produce the exact row to
// insert into llm_call_events (issue 5.1's schema, extended by 5.4 with
// event_id).
//
// Deliberately takes its I/O as injected async functions
// (WriteLlmCallEventDeps) rather than a Supabase client directly, for
// the same reason 4.4's resolvePriceForEvent takes an already-fetched
// row array instead of querying itself: it keeps this function
// trivially unit-testable with plain fakes, and keeps the actual
// Supabase wiring (supabase-event-repository.ts) as a separate, thin
// adapter that both the future HTTP endpoint (issue 6.1) and the queue
// worker (issue 7.3) can share.
//
// Issue 5.4: `payload.eventId` is the SDK's client-generated idempotency
// key, resent unchanged on every retry of the same real LLM call.
// `deps.insertEvent` is expected to perform an insert-or-ignore against
// the DB's `unique(event_id)` constraint (AC2 -- enforced at the DB
// level, not just here) and report back whether this call actually
// inserted a new row or hit an existing one (`wasDuplicate`). Either
// way, writeLlmCallEvent returns the row's *actual, stored* id/cost --
// never a second row, never a mismatched value on a retry (AC1).
//
// Known, accepted limitation: if the very first attempt at an event
// with an unresolvable price is retried, deps.alertPriceUnresolved
// fires again on each retry (this function resolves price and may
// alert *before* dedup is known, since dedup is only discovered at
// insert time). This only risks a duplicate log line for an
// already-flagged pricing gap -- it never duplicates a row or a cost --
// and de-duplicating the alert itself was judged out of scope for this
// issue's stated acceptance criteria.

export type SupportedProvider = "openai" | "anthropic";
export type EventStatus = "success" | "error";

export interface ValidatedEventPayload {
  /** Client-generated idempotency key (issue 5.4) -- the same real LLM
   * call must always resend the same eventId on retry. */
  eventId: string;
  projectId: string;
  provider: SupportedProvider;
  model: string;
  inputTokens: number;
  outputTokens: number;
  customerId?: string | null;
  featureId?: string | null;
  occurredAt: string | Date;
  status: EventStatus;
}

/** Exact shape of a row to insert into public.llm_call_events (issue 5.1, +event_id from 5.4). */
export interface LLMCallEventInsertRow {
  event_id: string;
  project_id: string;
  provider: SupportedProvider;
  model: string;
  input_tokens: number;
  output_tokens: number;
  computed_cost_usd: string | null;
  customer_id: string | null;
  feature_id: string | null;
  occurred_at: string;
  status: EventStatus;
}

/** Details passed to the internal alert when no price resolves for an event. */
export interface PriceUnresolvedAlert {
  projectId: string;
  provider: string;
  model: string;
  occurredAt: string;
}

export interface InsertEventOutcome {
  id: string;
  costUsd: string | null;
  /** True if this call hit an existing row via the event_id unique
   * constraint rather than inserting a new one (issue 5.4). */
  wasDuplicate: boolean;
}

export interface WriteLlmCallEventDeps {
  /** All PriceTable rows for this exact (provider, model) — the caller
   * decides how to fetch them; resolvePriceForEvent does the boundary
   * logic once they're in hand. */
  fetchPriceRows: (
    provider: string,
    model: string,
  ) => Promise<readonly PriceTableRow[]>;
  /** Must perform an insert-or-ignore keyed on event_id (issue 5.4) and
   * return the row's real, stored id/cost whether freshly inserted or
   * already present. */
  insertEvent: (row: LLMCallEventInsertRow) => Promise<InsertEventOutcome>;
  /** Called (best-effort) whenever an event's price could not be
   * resolved, so the team notices the pricing gap (issue 5.3). Never
   * allowed to block or fail the write. */
  alertPriceUnresolved: (
    details: PriceUnresolvedAlert,
  ) => void | Promise<void>;
}

export interface WriteLlmCallEventResult {
  id: string;
  costUsd: string | null;
  wasDuplicate: boolean;
}

export async function writeLlmCallEvent(
  deps: WriteLlmCallEventDeps,
  payload: ValidatedEventPayload,
): Promise<WriteLlmCallEventResult> {
  const priceRows = await deps.fetchPriceRows(payload.provider, payload.model);
  const resolvedPrice = resolvePriceForEvent(
    priceRows,
    payload.provider,
    payload.model,
    payload.occurredAt,
  );

  const occurredAtIso = toIso(payload.occurredAt);
  let costUsd: string | null;

  if (resolvedPrice) {
    costUsd = computeCostUsd(payload.inputTokens, payload.outputTokens, resolvedPrice);
  } else {
    costUsd = null;
    try {
      await deps.alertPriceUnresolved({
        projectId: payload.projectId,
        provider: payload.provider,
        model: payload.model,
        occurredAt: occurredAtIso,
      });
    } catch {
      // Alerting is best-effort only (issue 5.3) -- a broken alert
      // channel must never prevent the event from being written.
    }
  }

  const row: LLMCallEventInsertRow = {
    event_id: payload.eventId,
    project_id: payload.projectId,
    provider: payload.provider,
    model: payload.model,
    input_tokens: payload.inputTokens,
    output_tokens: payload.outputTokens,
    computed_cost_usd: costUsd,
    customer_id: payload.customerId ?? null,
    feature_id: payload.featureId ?? null,
    occurred_at: occurredAtIso,
    status: payload.status,
  };

  const outcome = await deps.insertEvent(row);
  // Always return the row's actual stored values, not the locally
  // computed ones -- on a duplicate (issue 5.4), that's the original
  // attempt's real cost, which is what the caller should see.
  return { id: outcome.id, costUsd: outcome.costUsd, wasDuplicate: outcome.wasDuplicate };
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
