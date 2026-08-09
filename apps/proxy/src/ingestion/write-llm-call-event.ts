import { computeCostUsd, resolvePriceForEvent, type PriceTableRow } from "@volar/shared";

// Issue 5.2 (Epic 5): server-side event-write function.
// Issue 5.3 (Epic 5): null-cost handling + internal alert stub.
//
// Takes an already-validated incoming event payload (validation itself
// is issue 6.3's job -- this function assumes its input is well-formed)
// and performs the three steps every ingested event needs: resolve the
// PriceTable version in effect at the time of the call (issue 4.4),
// compute the cost from it (issue 4.3), and produce the exact row to
// insert into llm_call_events (issue 5.1's schema).
//
// Deliberately takes its I/O as three injected async functions
// (WriteLlmCallEventDeps) rather than a Supabase client directly, for
// the same reason 4.4's resolvePriceForEvent takes an already-fetched
// row array instead of querying itself: it keeps this function
// trivially unit-testable with plain fakes, and keeps the actual
// Supabase wiring (supabase-event-repository.ts) as a separate, thin
// adapter that both the future HTTP endpoint (issue 6.1) and the queue
// worker (issue 7.3) can share.
//
// AC1 ("insert always carries a computed_cost_usd or explicit null,
// never a silently wrong number"): if no PriceTable row resolves for
// this provider/model/occurred_at, costUsd is null and the row is still
// inserted -- the write must never fail or guess just because pricing
// data is missing.
//
// Issue 5.3 builds directly on that null-cost branch: whenever it's
// taken, deps.alertPriceUnresolved is called so the team notices the
// pricing gap (a log line for V1, per this issue's description --
// swapping in real Sentry reporting later, issue 19.2, only means
// changing which function is passed in here, not this file). The alert
// is best-effort and never allowed to block or fail the write itself --
// a broken alert channel is not a reason to lose an event's cost data,
// so any error it throws is swallowed after the price-unresolved branch
// has already decided costUsd is null.

export type SupportedProvider = "openai" | "anthropic";
export type EventStatus = "success" | "error";

export interface ValidatedEventPayload {
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

/** Exact shape of a row to insert into public.llm_call_events (issue 5.1). */
export interface LLMCallEventInsertRow {
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

export interface WriteLlmCallEventDeps {
  /** All PriceTable rows for this exact (provider, model) — the caller
   * decides how to fetch them; resolvePriceForEvent does the boundary
   * logic once they're in hand. */
  fetchPriceRows: (
    provider: string,
    model: string,
  ) => Promise<readonly PriceTableRow[]>;
  insertEvent: (row: LLMCallEventInsertRow) => Promise<{ id: string }>;
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

  const inserted = await deps.insertEvent(row);
  return { id: inserted.id, costUsd };
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
