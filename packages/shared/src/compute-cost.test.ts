import { describe, it, expect } from "vitest";
import { computeCostUsd } from "./compute-cost.js";

describe("computeCostUsd", () => {
  it("returns 0 for zero tokens", () => {
    expect(
      computeCostUsd(0, 0, {
        inputPricePer1kTokensUsd: "0.0050",
        outputPricePer1kTokensUsd: "0.0250",
      }),
    ).toBe("0");
  });

  // Hand-calculated example (issue 4.3's extra DoD requires a second
  // manual verification pass against exactly this kind of calculation
  // before merge — reviewer, please recompute by hand):
  //   1500 input tokens @ $0.0020/1k tokens  = 1.5 * 0.002 = $0.003
  //    500 output tokens @ $0.0120/1k tokens = 0.5 * 0.012 = $0.006
  //   total = $0.003 + $0.006 = $0.009
  // Prices are the real seeded gpt-5.6-terra rate (issue 4.2).
  it("matches a hand-calculated example (gpt-5.6-terra pricing)", () => {
    const cost = computeCostUsd(1500, 500, {
      inputPricePer1kTokensUsd: "0.0020",
      outputPricePer1kTokensUsd: "0.0120",
    });
    expect(cost).toBe("0.009");
  });

  // Second hand-calculated example, at a much larger scale, using the
  // real seeded claude-opus-5 rate (issue 4.2):
  //   10,000,000 input tokens @ $0.0050/1k  = 10,000 * 0.005 = $50
  //    5,000,000 output tokens @ $0.0250/1k =  5,000 * 0.025 = $125
  //   total = $50 + $125 = $175
  it("handles large token counts precisely (claude-opus-5 pricing)", () => {
    const cost = computeCostUsd(10_000_000, 5_000_000, {
      inputPricePer1kTokensUsd: "0.0050",
      outputPricePer1kTokensUsd: "0.0250",
    });
    expect(cost).toBe("175");
  });

  it("avoids floating-point drift that plain JS number arithmetic would introduce", () => {
    // Plain JS: (1000/1000 * 0.1) + (1000/1000 * 0.2) === 0.30000000000000004
    // This test exists specifically to prove decimal.js avoids that.
    const cost = computeCostUsd(1000, 1000, {
      inputPricePer1kTokensUsd: 0.1,
      outputPricePer1kTokensUsd: 0.2,
    });
    expect(cost).toBe("0.3");
  });

  it("accepts numeric-typed prices as well as string-typed prices", () => {
    // Supabase returns `numeric` columns as strings; test literals here
    // are plain numbers. Both must produce identical results.
    const costFromStrings = computeCostUsd(2000, 1000, {
      inputPricePer1kTokensUsd: "0.005",
      outputPricePer1kTokensUsd: "0.025",
    });
    const costFromNumbers = computeCostUsd(2000, 1000, {
      inputPricePer1kTokensUsd: 0.005,
      outputPricePer1kTokensUsd: 0.025,
    });
    expect(costFromStrings).toBe(costFromNumbers);
  });

  it("rejects negative token counts", () => {
    expect(() =>
      computeCostUsd(-1, 0, {
        inputPricePer1kTokensUsd: "0.005",
        outputPricePer1kTokensUsd: "0.025",
      }),
    ).toThrow(RangeError);
  });

  it("rejects non-integer token counts", () => {
    expect(() =>
      computeCostUsd(1.5, 0, {
        inputPricePer1kTokensUsd: "0.005",
        outputPricePer1kTokensUsd: "0.025",
      }),
    ).toThrow(RangeError);
  });
});
