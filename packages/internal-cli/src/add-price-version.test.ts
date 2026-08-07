import { describe, it, expect } from "vitest";
import { validateArgs, resolveVersion, SUPPORTED_PROVIDERS } from "./add-price-version.js";

describe("validateArgs", () => {
  const base = {
    provider: "anthropic",
    model: "claude-sonnet-5",
    effectiveFrom: "2026-10-01T00:00:00Z",
    inputPrice: "0.0030",
    outputPrice: "0.0150",
  };

  it("accepts a fully valid set of args and normalizes the timestamp", () => {
    const result = validateArgs(base);
    expect(result.provider).toBe("anthropic");
    expect(result.model).toBe("claude-sonnet-5");
    expect(result.effectiveFromIso).toBe("2026-10-01T00:00:00.000Z");
    expect(result.inputPricePer1kTokensUsd).toBe(0.003);
    expect(result.outputPricePer1kTokensUsd).toBe(0.015);
    expect(result.source).toBe("provider-published-pricing-page");
  });

  it("uses a custom --source when provided", () => {
    const result = validateArgs({ ...base, source: "anthropic-pricing-email-2026-10-01" });
    expect(result.source).toBe("anthropic-pricing-email-2026-10-01");
  });

  it("rejects a provider outside the supported list", () => {
    expect(() => validateArgs({ ...base, provider: "cohere" })).toThrow(
      /--provider must be one of/,
    );
  });

  it("rejects a missing model", () => {
    expect(() => validateArgs({ ...base, model: "" })).toThrow("--model is required");
  });

  it("rejects an unparseable effective-from timestamp", () => {
    expect(() => validateArgs({ ...base, effectiveFrom: "not-a-date" })).toThrow(
      /not a valid timestamp/,
    );
  });

  it("rejects a negative input price", () => {
    expect(() => validateArgs({ ...base, inputPrice: "-0.001" })).toThrow(
      /--input-price must be a non-negative number/,
    );
  });

  it("rejects a non-numeric output price", () => {
    expect(() => validateArgs({ ...base, outputPrice: "free" })).toThrow(
      /--output-price must be a non-negative number/,
    );
  });

  it("rejects a non-integer explicit version", () => {
    expect(() => validateArgs({ ...base, version: "1.5" })).toThrow(
      /--version must be a positive integer/,
    );
  });

  it("supports both providers in the CHECK constraint", () => {
    expect(SUPPORTED_PROVIDERS).toEqual(["openai", "anthropic"]);
  });
});

describe("resolveVersion", () => {
  it("returns 1 when no versions exist yet for this provider/model", () => {
    expect(resolveVersion([], undefined)).toBe(1);
  });

  it("auto-increments to one past the current max version", () => {
    expect(resolveVersion([1, 2], undefined)).toBe(3);
  });

  it("auto-increments correctly even if existing versions are out of order", () => {
    expect(resolveVersion([2, 1, 3], undefined)).toBe(4);
  });

  it("accepts an explicit version that doesn't collide", () => {
    expect(resolveVersion([1, 2], 5)).toBe(5);
  });

  it("refuses an explicit version that already exists (AC2: no duplicates)", () => {
    expect(() => resolveVersion([1, 2], 2)).toThrow(/version 2 already exists/);
  });
});
