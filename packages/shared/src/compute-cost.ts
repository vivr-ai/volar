import { Decimal } from "decimal.js";

// Issue 4.3 (Epic 4): deterministic cost computation.
// PRD §8 FR-8.1: cost = (input_tokens/1000 * input_price_per_1k) +
// (output_tokens/1000 * output_price_per_1k), computed against the
// PriceTable version in effect at the event's occurred_at (issue 4.4
// resolves which version that is — this function only does the
// arithmetic once a price is already resolved). This is the *only*
// source of a cost figure anywhere in the product — no LLM, heuristic,
// or estimate may produce one instead (FR-8.1).
//
// Uses decimal.js rather than plain JS number arithmetic, for two
// reasons:
// 1. Postgres `numeric` columns (PriceTable's price fields) round-trip
//    through Supabase as strings, not floats, specifically to avoid
//    precision loss — this function accepts that shape directly rather
//    than forcing a lossy parseFloat() at the call site.
// 2. This is explicitly the single most trust-critical calculation in
//    V1 (per this issue's Definition of Done, which requires a second
//    manual verification pass against a hand-calculated example before
//    merge). Floating-point arithmetic — e.g. 0.1 + 0.2 !== 0.3 in IEEE
//    754 — is exactly the kind of subtle bug that has no place in a
//    cost figure customers will reconcile against a real provider
//    invoice. See compute-cost.test.ts for a test that demonstrates this
//    directly.
//
// Pure function: no DB access, no network access, no dependency on
// anything but its arguments — reusable from the ingestion proxy (issue
// 5.2) and fully testable in isolation.

export interface ResolvedPrice {
  /** PriceTable.input_price_per_1k_tokens_usd for the resolved version. */
  inputPricePer1kTokensUsd: string | number;
  /** PriceTable.output_price_per_1k_tokens_usd for the resolved version. */
  outputPricePer1kTokensUsd: string | number;
}

/**
 * Computes cost_usd for a single LLM call. Returns the exact decimal
 * result as a string (not a number) so callers can insert it directly
 * into a `numeric` database column without any float round-tripping.
 */
export function computeCostUsd(
  inputTokens: number,
  outputTokens: number,
  price: ResolvedPrice,
): string {
  if (!Number.isInteger(inputTokens) || inputTokens < 0) {
    throw new RangeError(
      `inputTokens must be a non-negative integer, got ${inputTokens}`,
    );
  }
  if (!Number.isInteger(outputTokens) || outputTokens < 0) {
    throw new RangeError(
      `outputTokens must be a non-negative integer, got ${outputTokens}`,
    );
  }

  const inputCost = new Decimal(inputTokens)
    .div(1000)
    .mul(price.inputPricePer1kTokensUsd);
  const outputCost = new Decimal(outputTokens)
    .div(1000)
    .mul(price.outputPricePer1kTokensUsd);

  return inputCost.plus(outputCost).toString();
}
