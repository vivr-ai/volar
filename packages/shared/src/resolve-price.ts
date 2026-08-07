// Issue 4.4 (Epic 4): price-table lookup-by-effective-date logic.
// Given a provider, model, and occurred_at timestamp, resolves which
// PriceTable version was actually in effect at that instant — needed
// because PRD FR-8.2 makes price changes append-only (new versioned
// rows, never edits to past rows), so "the price for this model" always
// depends on *when* the call happened, not just what the current price
// is today.
//
// Pure function (same pattern as 4.3's computeCostUsd): takes an
// already-fetched array of rows rather than querying the database
// itself, so it's usable whether the caller fetched one provider/model's
// full history or the entire price table, and is fully unit-testable
// without a database connection. The actual SQL a caller runs can use
// the (provider, model, effective_from) index from issue 4.1 to narrow
// this down efficiently before calling in.

export interface PriceTableRow {
  provider: string;
  model: string;
  effectiveFrom: string | Date;
  version: number;
  inputPricePer1kTokensUsd: string | number;
  outputPricePer1kTokensUsd: string | number;
}

/**
 * Resolves the PriceTable row in effect for (provider, model) at
 * occurredAt. Returns null — never a guess — if no row's effective_from
 * is at or before occurredAt for that provider/model (e.g., the price
 * table doesn't cover this model, or occurredAt predates the earliest
 * known price).
 *
 * Boundary is inclusive: a row is "in effect" starting at the exact
 * instant of its effective_from, matching the plain-English meaning of
 * "effective from this timestamp."
 */
export function resolvePriceForEvent(
  rows: readonly PriceTableRow[],
  provider: string,
  model: string,
  occurredAt: string | Date,
): PriceTableRow | null {
  const occurredAtMs = toMillis(occurredAt);

  const candidates = rows.filter(
    (row) =>
      row.provider === provider &&
      row.model === model &&
      toMillis(row.effectiveFrom) <= occurredAtMs,
  );

  if (candidates.length === 0) {
    return null;
  }

  // The correct version is the most recent price change that had
  // already taken effect by occurredAt — i.e. the candidate with the
  // latest effective_from. Tie-break on version (monotonically
  // increasing per PRD §7) in case two rows ever share an
  // effective_from, which shouldn't happen but shouldn't silently pick
  // an arbitrary one either.
  candidates.sort((a, b) => {
    const byDate = toMillis(b.effectiveFrom) - toMillis(a.effectiveFrom);
    return byDate !== 0 ? byDate : b.version - a.version;
  });

  return candidates[0];
}

function toMillis(value: string | Date): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}
