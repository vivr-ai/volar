import { describe, it, expect } from "vitest";
import { computeCostUsd } from "./compute-cost.js";
import { resolvePriceForEvent } from "./resolve-price.js";
import { RECONCILIATION_FIXTURES, SEEDED_PRICE_TABLE } from "./reconciliation.fixtures.js";

// Issue 5.5 (Epic 5): reconciliation fixture test suite.
// Exercises the full 4.4 (price resolution) + 4.3 (cost computation)
// path against a table of independently-verified expected values, to
// catch any future regression in either function. AC1 requires >=10
// fixtures across both providers/multiple models -- enforced below so
// this suite can't silently shrink under the threshold. AC2 (runs in CI
// on every PR touching 4.3/4.4/5.2) is satisfied by
// .github/workflows/shared-ci.yml (this file lives in packages/shared,
// where 4.3/4.4 also live) and proxy-ci.yml already triggering on
// packages/shared/** changes -- see docs/CI.md for the full writeup,
// including a real CI gap found and fixed while closing this issue.

describe("reconciliation fixtures", () => {
  it("has at least 10 fixtures covering both providers and multiple models (AC1)", () => {
    expect(RECONCILIATION_FIXTURES.length).toBeGreaterThanOrEqual(10);
    const providers = new Set(RECONCILIATION_FIXTURES.map((f) => f.provider));
    const models = new Set(RECONCILIATION_FIXTURES.map((f) => f.model));
    expect(providers).toEqual(new Set(["openai", "anthropic"]));
    expect(models.size).toBeGreaterThanOrEqual(5);
  });

  it("every fixture documents its expected-value source (AC3)", () => {
    for (const fixture of RECONCILIATION_FIXTURES) {
      expect(fixture.expectedValueSource.length).toBeGreaterThan(0);
    }
  });

  for (const fixture of RECONCILIATION_FIXTURES) {
    it(`${fixture.description} -> $${fixture.expectedCostUsd}`, () => {
      const resolved = resolvePriceForEvent(
        SEEDED_PRICE_TABLE,
        fixture.provider,
        fixture.model,
        fixture.occurredAt,
      );
      expect(resolved).not.toBeNull();

      const cost = computeCostUsd(fixture.inputTokens, fixture.outputTokens, resolved!);
      expect(cost).toBe(fixture.expectedCostUsd);
    });
  }
});
