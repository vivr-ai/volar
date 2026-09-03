import { describe, it, expect } from "vitest";
import { reconcileBurst } from "./reconcile.js";

describe("reconcileBurst", () => {
  it("reports zero missing when every sent event was persisted (AC2 passing case)", () => {
    const sent = ["a", "b", "c"];
    const result = reconcileBurst(sent, ["a", "b", "c"], []);
    expect(result).toEqual({
      sentCount: 3,
      matchedCount: 3,
      deadLetteredCount: 0,
      missingEventIds: [],
    });
  });

  it("counts a dead-lettered event as accounted for, not missing", () => {
    const result = reconcileBurst(["a", "b"], ["a"], ["b"]);
    expect(result.matchedCount).toBe(1);
    expect(result.deadLetteredCount).toBe(1);
    expect(result.missingEventIds).toEqual([]);
  });

  it("reports an event found in neither table as missing (AC2 failing case)", () => {
    const result = reconcileBurst(["a", "b", "c"], ["a"], ["b"]);
    expect(result.missingEventIds).toEqual(["c"]);
  });

  it("handles an empty sent list", () => {
    const result = reconcileBurst([], [], []);
    expect(result).toEqual({ sentCount: 0, matchedCount: 0, deadLetteredCount: 0, missingEventIds: [] });
  });

  it("does not double-count an id present in both persisted and dead-lettered (persisted wins)", () => {
    // Shouldn't happen in practice (event_id is unique in llm_call_events
    // and the worker only dead-letters after giving up), but the diff
    // logic should still behave predictably rather than double-counting.
    const result = reconcileBurst(["a"], ["a"], ["a"]);
    expect(result.matchedCount).toBe(1);
    expect(result.deadLetteredCount).toBe(0);
  });
});
