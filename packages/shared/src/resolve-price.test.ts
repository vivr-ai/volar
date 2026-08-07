import { describe, it, expect } from "vitest";
import { resolvePriceForEvent, type PriceTableRow } from "./resolve-price.js";

// Real seeded PriceTable data (issue 4.2): Claude Sonnet 5 has two real
// versions — introductory pricing effective at seed time, and standard
// pricing effective 2026-09-01. gpt-5.6-terra is included to prove
// provider/model matching doesn't cross-contaminate.
const rows: PriceTableRow[] = [
  {
    provider: "anthropic",
    model: "claude-sonnet-5",
    effectiveFrom: "2026-08-07T00:00:00Z",
    version: 1,
    inputPricePer1kTokensUsd: "0.0020",
    outputPricePer1kTokensUsd: "0.0100",
  },
  {
    provider: "anthropic",
    model: "claude-sonnet-5",
    effectiveFrom: "2026-09-01T00:00:00Z",
    version: 2,
    inputPricePer1kTokensUsd: "0.0030",
    outputPricePer1kTokensUsd: "0.0150",
  },
  {
    provider: "openai",
    model: "gpt-5.6-terra",
    effectiveFrom: "2026-08-07T00:00:00Z",
    version: 1,
    inputPricePer1kTokensUsd: "0.0020",
    outputPricePer1kTokensUsd: "0.0120",
  },
];

describe("resolvePriceForEvent", () => {
  it("resolves the v1 price for a timestamp between the two price changes", () => {
    const result = resolvePriceForEvent(
      rows,
      "anthropic",
      "claude-sonnet-5",
      "2026-08-20T12:00:00Z",
    );
    expect(result?.version).toBe(1);
  });

  it("resolves the v2 price for a timestamp after the second change", () => {
    const result = resolvePriceForEvent(
      rows,
      "anthropic",
      "claude-sonnet-5",
      "2026-09-15T00:00:00Z",
    );
    expect(result?.version).toBe(2);
  });

  it("includes the exact boundary instant in the newer version (inclusive lower bound)", () => {
    const result = resolvePriceForEvent(
      rows,
      "anthropic",
      "claude-sonnet-5",
      "2026-09-01T00:00:00.000Z",
    );
    expect(result?.version).toBe(2);
  });

  it("resolves one millisecond before the boundary to the older version", () => {
    const result = resolvePriceForEvent(
      rows,
      "anthropic",
      "claude-sonnet-5",
      "2026-08-31T23:59:59.999Z",
    );
    expect(result?.version).toBe(1);
  });

  it("returns null for a model that isn't in the price table", () => {
    const result = resolvePriceForEvent(
      rows,
      "anthropic",
      "claude-haiku-9000",
      "2026-08-20T00:00:00Z",
    );
    expect(result).toBeNull();
  });

  it("returns null when occurredAt predates the earliest known price", () => {
    const result = resolvePriceForEvent(
      rows,
      "anthropic",
      "claude-sonnet-5",
      "2026-01-01T00:00:00Z",
    );
    expect(result).toBeNull();
  });

  it("does not cross-match a model name that belongs to a different provider", () => {
    // gpt-5.6-terra exists, but only under "openai" — asking for it under
    // "anthropic" must not accidentally match.
    const result = resolvePriceForEvent(
      rows,
      "anthropic",
      "gpt-5.6-terra",
      "2026-08-20T00:00:00Z",
    );
    expect(result).toBeNull();
  });
});
