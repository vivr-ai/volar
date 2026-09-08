import { describe, it, expect } from "vitest";
import { computeTargetDateUtc } from "./compute-target-date.js";

describe("computeTargetDateUtc", () => {
  it("returns the prior UTC day for a mid-day timestamp", () => {
    expect(computeTargetDateUtc(new Date("2026-09-05T14:30:00.000Z"))).toBe("2026-09-04");
  });

  it("rolls over a month boundary correctly", () => {
    expect(computeTargetDateUtc(new Date("2026-09-01T00:30:00.000Z"))).toBe("2026-08-31");
  });

  it("rolls over a year boundary correctly", () => {
    expect(computeTargetDateUtc(new Date("2027-01-01T00:00:01.000Z"))).toBe("2026-12-31");
  });

  it("rolls over a leap-year February boundary correctly", () => {
    expect(computeTargetDateUtc(new Date("2028-03-01T00:00:00.000Z"))).toBe("2028-02-29");
  });

  it("is unaffected by the time-of-day component, only the UTC calendar date", () => {
    expect(computeTargetDateUtc(new Date("2026-09-05T23:59:59.999Z"))).toBe("2026-09-04");
    expect(computeTargetDateUtc(new Date("2026-09-05T00:00:00.000Z"))).toBe("2026-09-04");
  });
});
