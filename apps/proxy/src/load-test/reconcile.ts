// Issue 7.5, AC2 ("zero events lost during the burst"): pure diff
// logic, no I/O -- poll-persisted-events.ts is the thin adapter that
// actually queries Supabase for what to diff against.

export interface ReconciliationResult {
  sentCount: number;
  /** Events found in llm_call_events -- successfully processed by the
   * worker (issue 7.3). */
  matchedCount: number;
  /** Events found in ingestion_dead_letters -- accounted for, but the
   * worker gave up on them (issue 7.4). Not "lost" in AC2's sense, but
   * a real signal the burst pushed something to its failure path and
   * worth surfacing, not silently folding into "missing". */
  deadLetteredCount: number;
  /** Sent event_ids found in neither table -- AC2 passes only when this
   * is empty. */
  missingEventIds: string[];
}

export function reconcileBurst(
  sentEventIds: readonly string[],
  persistedEventIds: readonly string[],
  deadLetteredEventIds: readonly string[],
): ReconciliationResult {
  const persisted = new Set(persistedEventIds);
  const deadLettered = new Set(deadLetteredEventIds);

  let matchedCount = 0;
  let deadLetteredCount = 0;
  const missingEventIds: string[] = [];

  for (const eventId of sentEventIds) {
    if (persisted.has(eventId)) {
      matchedCount++;
    } else if (deadLettered.has(eventId)) {
      deadLetteredCount++;
    } else {
      missingEventIds.push(eventId);
    }
  }

  return {
    sentCount: sentEventIds.length,
    matchedCount,
    deadLetteredCount,
    missingEventIds,
  };
}
