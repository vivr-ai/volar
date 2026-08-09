import type { PriceTableRow } from "./resolve-price.js";

// Issue 5.5 (Epic 5): reconciliation fixture suite.
//
// This is the real PriceTable snapshot seeded in issue 4.2
// (supabase/seed.sql) -- using the actual seeded rows (not invented
// numbers) means these fixtures double as documentation of what a real
// customer's dashboard cost figure should look like for these exact
// models, and keeps this suite from drifting out of sync with what's
// actually in production.
export const SEEDED_PRICE_TABLE: readonly PriceTableRow[] = [
  { provider: "openai", model: "gpt-5.6-sol", effectiveFrom: "2026-08-07T00:00:00Z", version: 1, inputPricePer1kTokensUsd: "0.0050", outputPricePer1kTokensUsd: "0.0300" },
  { provider: "openai", model: "gpt-5.6-terra", effectiveFrom: "2026-08-07T00:00:00Z", version: 1, inputPricePer1kTokensUsd: "0.0020", outputPricePer1kTokensUsd: "0.0120" },
  { provider: "openai", model: "gpt-5.6-luna", effectiveFrom: "2026-08-07T00:00:00Z", version: 1, inputPricePer1kTokensUsd: "0.0002", outputPricePer1kTokensUsd: "0.0012" },
  { provider: "anthropic", model: "claude-opus-5", effectiveFrom: "2026-08-07T00:00:00Z", version: 1, inputPricePer1kTokensUsd: "0.0050", outputPricePer1kTokensUsd: "0.0250" },
  { provider: "anthropic", model: "claude-sonnet-5", effectiveFrom: "2026-08-07T00:00:00Z", version: 1, inputPricePer1kTokensUsd: "0.0020", outputPricePer1kTokensUsd: "0.0100" },
  { provider: "anthropic", model: "claude-sonnet-5", effectiveFrom: "2026-09-01T00:00:00Z", version: 2, inputPricePer1kTokensUsd: "0.0030", outputPricePer1kTokensUsd: "0.0150" },
  { provider: "anthropic", model: "claude-haiku-4-5-20251001", effectiveFrom: "2026-08-07T00:00:00Z", version: 1, inputPricePer1kTokensUsd: "0.0010", outputPricePer1kTokensUsd: "0.0050" },
];

export interface ReconciliationFixture {
  /** Short label identifying the scenario this fixture covers. */
  description: string;
  provider: string;
  model: string;
  occurredAt: string;
  inputTokens: number;
  outputTokens: number;
  /** Exact expected string computeCostUsd must return -- the canonical
   * decimal.js minimal-digit form (e.g. "0.009", not "0.00900"). */
  expectedCostUsd: string;
  /** How expectedCostUsd was independently derived, per this issue's
   * AC3. V1 hasn't shipped yet, so there is no real invoice to
   * reconcile against -- every fixture here is a hand calculation,
   * independently cross-checked with Python's decimal.Decimal (not
   * decimal.js, to avoid validating the implementation against itself)
   * rather than typed in from memory. Epic 21's reconciliation-vs-real-
   * invoice testing will supersede/extend this once real usage exists.
   */
  expectedValueSource: string;
}

// At least 10 fixtures (AC1), covering both providers and multiple
// models, cross-checked via:
//   python3 -c "from decimal import Decimal as D; print((D(IN)/1000*D(IP))+(D(OUT)/1000*D(OP)))"
export const RECONCILIATION_FIXTURES: readonly ReconciliationFixture[] = [
  {
    description: "openai/gpt-5.6-sol: whole-number token counts",
    provider: "openai",
    model: "gpt-5.6-sol",
    occurredAt: "2026-08-10T00:00:00Z",
    inputTokens: 1000,
    outputTokens: 1000,
    expectedCostUsd: "0.035",
    expectedValueSource: "hand calc: 1*0.0050 + 1*0.0300 = 0.035",
  },
  {
    description: "openai/gpt-5.6-terra: same example used in issue 4.3's unit tests",
    provider: "openai",
    model: "gpt-5.6-terra",
    occurredAt: "2026-08-10T00:00:00Z",
    inputTokens: 1500,
    outputTokens: 500,
    expectedCostUsd: "0.009",
    expectedValueSource: "hand calc: 1.5*0.0020 + 0.5*0.0120 = 0.009",
  },
  {
    description: "openai/gpt-5.6-luna: cheapest model, larger token counts",
    provider: "openai",
    model: "gpt-5.6-luna",
    occurredAt: "2026-08-10T00:00:00Z",
    inputTokens: 100_000,
    outputTokens: 50_000,
    expectedCostUsd: "0.08",
    expectedValueSource: "hand calc: 100*0.0002 + 50*0.0012 = 0.08",
  },
  {
    description: "openai/gpt-5.6-luna: zero tokens -> zero cost",
    provider: "openai",
    model: "gpt-5.6-luna",
    occurredAt: "2026-08-10T00:00:00Z",
    inputTokens: 0,
    outputTokens: 0,
    expectedCostUsd: "0",
    expectedValueSource: "hand calc: 0*price + 0*price = 0",
  },
  {
    description: "anthropic/claude-opus-5: same large-scale example used in issue 4.3's unit tests",
    provider: "anthropic",
    model: "claude-opus-5",
    occurredAt: "2026-08-10T00:00:00Z",
    inputTokens: 10_000_000,
    outputTokens: 5_000_000,
    expectedCostUsd: "175",
    expectedValueSource: "hand calc: 10,000*0.0050 + 5,000*0.0250 = 175",
  },
  {
    description: "anthropic/claude-opus-5: sub-cent precision (decimal.js precision check)",
    provider: "anthropic",
    model: "claude-opus-5",
    occurredAt: "2026-08-10T00:00:00Z",
    inputTokens: 1,
    outputTokens: 1,
    expectedCostUsd: "0.00003",
    expectedValueSource: "hand calc: 0.001*0.0050 + 0.001*0.0250 = 0.00003",
  },
  {
    description: "anthropic/claude-sonnet-5: v1 (introductory) price, before the Sep 1 change",
    provider: "anthropic",
    model: "claude-sonnet-5",
    occurredAt: "2026-08-20T00:00:00Z",
    inputTokens: 1000,
    outputTokens: 500,
    expectedCostUsd: "0.007",
    expectedValueSource: "hand calc: 1*0.0020 + 0.5*0.0100 = 0.007",
  },
  {
    description: "anthropic/claude-sonnet-5: v2 (standard) price, after the Sep 1 change",
    provider: "anthropic",
    model: "claude-sonnet-5",
    occurredAt: "2026-09-15T00:00:00Z",
    inputTokens: 1000,
    outputTokens: 500,
    expectedCostUsd: "0.0105",
    expectedValueSource: "hand calc: 1*0.0030 + 0.5*0.0150 = 0.0105",
  },
  {
    description: "anthropic/claude-sonnet-5: exact effective_from boundary instant resolves to v2 (inclusive)",
    provider: "anthropic",
    model: "claude-sonnet-5",
    occurredAt: "2026-09-01T00:00:00.000Z",
    inputTokens: 2000,
    outputTokens: 1000,
    expectedCostUsd: "0.021",
    expectedValueSource: "hand calc: 2*0.0030 + 1*0.0150 = 0.021 (v2, per issue 4.4's inclusive boundary)",
  },
  {
    description: "anthropic/claude-sonnet-5: one millisecond before the boundary resolves to v1",
    provider: "anthropic",
    model: "claude-sonnet-5",
    occurredAt: "2026-08-31T23:59:59.999Z",
    inputTokens: 2000,
    outputTokens: 1000,
    expectedCostUsd: "0.014",
    expectedValueSource: "hand calc: 2*0.0020 + 1*0.0100 = 0.014 (v1, per issue 4.4's boundary test)",
  },
  {
    description: "anthropic/claude-haiku-4-5: pinned dated model id",
    provider: "anthropic",
    model: "claude-haiku-4-5-20251001",
    occurredAt: "2026-08-10T00:00:00Z",
    inputTokens: 50_000,
    outputTokens: 20_000,
    expectedCostUsd: "0.15",
    expectedValueSource: "hand calc: 50*0.0010 + 20*0.0050 = 0.15",
  },
  {
    description: "openai/gpt-5.6-sol: realistic invoice-scale token counts",
    provider: "openai",
    model: "gpt-5.6-sol",
    occurredAt: "2026-08-10T00:00:00Z",
    inputTokens: 3_742_918,
    outputTokens: 812_004,
    expectedCostUsd: "43.07471",
    expectedValueSource: "hand calc: 3742.918*0.0050 + 812.004*0.0300 = 18.71459 + 24.36012 = 43.07471",
  },
];
