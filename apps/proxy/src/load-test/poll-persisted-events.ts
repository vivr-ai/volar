import type { SupabaseClient } from "@supabase/supabase-js";

// Issue 7.5: queries what actually landed in Postgres for a burst run,
// for reconcile.ts's pure diff to compare against what was sent.
//
// Deliberately queries by `project_id in (...)` (at most projectCount
// values, e.g. 10) rather than `event_id in (...)` against the full set
// of sent event_ids (which can be in the thousands for a real burst) --
// every project this queries was just freshly provisioned with zero
// existing rows (provision-fixtures.ts), so any row under one of these
// project_ids necessarily belongs to this run. This avoids ever
// building a huge IN-list, which risks PostgREST/URL-length limits for
// no benefit.

export interface PersistedEventIds {
  persistedEventIds: string[];
  deadLetteredEventIds: string[];
}

export interface PollOptions {
  timeoutMs: number;
  pollIntervalMs: number;
}

/**
 * Polls llm_call_events + ingestion_dead_letters until every sent event
 * is accounted for (inserted or dead-lettered) or `timeoutMs` elapses.
 * A single query taken immediately after the burst finishes would
 * report false "missing" events that are simply still in flight -- the
 * worker (issue 7.3) drains the queue asynchronously, not synchronously
 * with the HTTP response (issue 7.2's whole point).
 */
export async function pollForReconciliation(
  supabase: SupabaseClient,
  projectIds: string[],
  totalSent: number,
  options: PollOptions,
): Promise<PersistedEventIds> {
  const deadline = Date.now() + options.timeoutMs;

  for (;;) {
    const [persistedResult, deadLetteredResult] = await Promise.all([
      supabase.from("llm_call_events").select("event_id").in("project_id", projectIds),
      supabase.from("ingestion_dead_letters").select("event_id").in("project_id", projectIds),
    ]);

    if (persistedResult.error) {
      throw new Error(`Failed to query llm_call_events: ${persistedResult.error.message}`);
    }
    if (deadLetteredResult.error) {
      throw new Error(
        `Failed to query ingestion_dead_letters: ${deadLetteredResult.error.message}`,
      );
    }

    const persistedEventIds = (persistedResult.data ?? []).map(
      (row) => (row as { event_id: string }).event_id,
    );
    const deadLetteredEventIds = (deadLetteredResult.data ?? [])
      .map((row) => (row as { event_id: string | null }).event_id)
      .filter((id): id is string => id !== null);

    const accountedFor = persistedEventIds.length + deadLetteredEventIds.length;
    if (accountedFor >= totalSent || Date.now() >= deadline) {
      return { persistedEventIds, deadLetteredEventIds };
    }

    await sleep(options.pollIntervalMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
