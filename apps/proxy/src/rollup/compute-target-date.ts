// Issue 8.1 (Epic 8): pure date logic for the daily rollup job.
// FR-8.3: "aggregates the *prior* UTC day's LLMCallEvents" -- pure
// function, no I/O, unit-testable with an injected clock, same pattern
// as this codebase's other pure decision logic (rate-limiter.ts's
// checkRateLimit, dead-letter.ts's isFinalAttempt).

/**
 * Returns "yesterday" in UTC as a YYYY-MM-DD string, matching
 * daily_cost_rollups.date's column type (issue 8.0). Uses Date.UTC's
 * own arithmetic (not manual day-of-month math) so month/year
 * boundaries roll over correctly -- e.g. a `now` of
 * 2026-09-01T00:30:00Z correctly yields "2026-08-31", not "2026-09-00"
 * or similar.
 */
export function computeTargetDateUtc(now: Date): string {
  const yesterday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1),
  );
  const yyyy = yesterday.getUTCFullYear();
  const mm = String(yesterday.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(yesterday.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
