import type { ValidatedEventPayload } from "./write-llm-call-event.js";

// Issue 7.2 (Epic 7): enqueue validated events onto the ingestion
// queue (provisioned in issue 7.1) instead of writing them to Postgres
// directly.
//
// Same two-layer split as every other ingestion piece in this codebase
// (writeLlmCallEvent / createSupabaseEventWriteDeps,
// authenticateApiKey / createSupabaseApiKeyAuthDeps): a small,
// dependency-injected orchestration function here, with the real
// Supabase RPC call living in supabase-queue-repository.ts as a thin
// adapter. Deliberately its own file (not folded into events.ts)
// so it's unit-testable against a plain in-memory fake, same as
// everything else at this layer.

export interface EnqueueIngestionEventDeps {
  enqueueEvent: (payload: ValidatedEventPayload) => Promise<{ msgId: number }>;
}

export interface EnqueueOutcome {
  eventId: string;
  enqueued: boolean;
  /** Only present when `enqueued` is false -- the rejection reason
   * from the underlying enqueueEvent call, for the caller to log. */
  error?: unknown;
}

/**
 * Enqueues every event in `events` in parallel (independent events,
 * no ordering dependency between them -- and NFR §10.2's latency
 * budget favors doing this concurrently over a sequential loop).
 * Never throws: every outcome (success or failure) is reported back
 * per-event via the returned array's `enqueued` flag, using
 * Promise.allSettled rather than Promise.all specifically so one
 * failed enqueue doesn't abort in-flight enqueues for the rest of the
 * batch. The caller (events.ts) decides what to do with a mix of
 * outcomes -- see its own comment for that judgment call.
 */
export async function enqueueValidatedEvents(
  deps: EnqueueIngestionEventDeps,
  events: readonly ValidatedEventPayload[],
): Promise<EnqueueOutcome[]> {
  if (events.length === 0) {
    return [];
  }

  const settled = await Promise.allSettled(events.map((event) => deps.enqueueEvent(event)));

  return settled.map((result, index) => ({
    eventId: events[index].eventId,
    enqueued: result.status === "fulfilled",
    error: result.status === "rejected" ? result.reason : undefined,
  }));
}
