import { describe, it, expect, vi } from "vitest";
import type { PriceTableRow } from "@volar/shared";
import {
  writeLlmCallEvent,
  type WriteLlmCallEventDeps,
  type InsertEventOutcome,
  type LLMCallEventInsertRow,
} from "./write-llm-call-event.js";

const sonnetRows: PriceTableRow[] = [
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
];

// Fakes deps.insertEvent as a realistic insert-or-ignore-by-event_id
// store, mirroring the real Postgres unique(event_id) constraint +
// upsert(..., { ignoreDuplicates: true }) behavior (issue 5.4).
function makeDeps(
  priceRows: readonly PriceTableRow[],
  overrides: Partial<WriteLlmCallEventDeps> = {},
): {
  deps: WriteLlmCallEventDeps;
  insertedRows: LLMCallEventInsertRow[];
  alertPriceUnresolved: ReturnType<typeof vi.fn>;
} {
  const insertedRows: LLMCallEventInsertRow[] = [];
  const byEventId = new Map<string, InsertEventOutcome>();
  let nextId = 1;
  const alertPriceUnresolved = vi.fn(async () => undefined);

  const deps: WriteLlmCallEventDeps = {
    fetchPriceRows: vi.fn(async () => priceRows),
    insertEvent: vi.fn(async (row: LLMCallEventInsertRow): Promise<InsertEventOutcome> => {
      const existing = byEventId.get(row.event_id);
      if (existing) {
        return { ...existing, wasDuplicate: true };
      }
      insertedRows.push(row);
      const outcome: InsertEventOutcome = {
        id: `row-${nextId++}`,
        costUsd: row.computed_cost_usd,
        wasDuplicate: false,
      };
      byEventId.set(row.event_id, outcome);
      return outcome;
    }),
    alertPriceUnresolved,
    ...overrides,
  };
  return { deps, insertedRows, alertPriceUnresolved };
}

describe("writeLlmCallEvent", () => {
  it("resolves the correct price version and computes cost (hand-calculated)", async () => {
    const { deps, insertedRows, alertPriceUnresolved } = makeDeps(sonnetRows);

    const result = await writeLlmCallEvent(deps, {
      eventId: "11111111-aaaa-aaaa-aaaa-111111111111",
      projectId: "33333333-3333-3333-3333-333333333333",
      provider: "anthropic",
      model: "claude-sonnet-5",
      inputTokens: 1500,
      outputTokens: 500,
      occurredAt: "2026-08-20T00:00:00Z",
      status: "success",
    });

    expect(result.costUsd).toBe("0.008");
    expect(result.wasDuplicate).toBe(false);
    expect(deps.fetchPriceRows).toHaveBeenCalledWith("anthropic", "claude-sonnet-5");
    expect(insertedRows).toHaveLength(1);
    expect(alertPriceUnresolved).not.toHaveBeenCalled();
  });

  it("resolves the newer price version once its effective_from has passed", async () => {
    const { deps } = makeDeps(sonnetRows);
    const result = await writeLlmCallEvent(deps, {
      eventId: "88888888-aaaa-aaaa-aaaa-888888888888",
      projectId: "33333333-3333-3333-3333-333333333333",
      provider: "anthropic",
      model: "claude-sonnet-5",
      inputTokens: 1000,
      outputTokens: 1000,
      occurredAt: "2026-09-15T00:00:00Z",
      status: "success",
    });
    expect(result.costUsd).toBe("0.018");
  });

  it("passes through customer_id and feature_id tags when present", async () => {
    const { deps, insertedRows } = makeDeps(sonnetRows);
    await writeLlmCallEvent(deps, {
      eventId: "99999999-aaaa-aaaa-aaaa-999999999999",
      projectId: "33333333-3333-3333-3333-333333333333",
      provider: "anthropic",
      model: "claude-sonnet-5",
      inputTokens: 100,
      outputTokens: 100,
      customerId: "cust-42",
      featureId: "summarizer",
      occurredAt: "2026-08-20T00:00:00Z",
      status: "success",
    });
    expect(insertedRows[0].customer_id).toBe("cust-42");
    expect(insertedRows[0].feature_id).toBe("summarizer");
  });

  it("stores a null cost, still inserts, and alerts when no price resolves for the model", async () => {
    const { deps, insertedRows, alertPriceUnresolved } = makeDeps(sonnetRows);
    const result = await writeLlmCallEvent(deps, {
      eventId: "22222222-aaaa-aaaa-aaaa-222222222222",
      projectId: "33333333-3333-3333-3333-333333333333",
      provider: "anthropic",
      model: "some-unreleased-model",
      inputTokens: 100,
      outputTokens: 100,
      occurredAt: "2026-08-20T00:00:00Z",
      status: "success",
    });

    expect(result.costUsd).toBeNull();
    expect(insertedRows).toHaveLength(1);
    expect(alertPriceUnresolved).toHaveBeenCalledTimes(1);
    expect(alertPriceUnresolved).toHaveBeenCalledWith({
      projectId: "33333333-3333-3333-3333-333333333333",
      provider: "anthropic",
      model: "some-unreleased-model",
      occurredAt: "2026-08-20T00:00:00.000Z",
    });
  });

  it("stores a null cost and alerts when occurred_at predates the earliest known price", async () => {
    const { deps, alertPriceUnresolved } = makeDeps(sonnetRows);
    const result = await writeLlmCallEvent(deps, {
      eventId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      projectId: "33333333-3333-3333-3333-333333333333",
      provider: "anthropic",
      model: "claude-sonnet-5",
      inputTokens: 100,
      outputTokens: 100,
      occurredAt: "2020-01-01T00:00:00Z",
      status: "success",
    });
    expect(result.costUsd).toBeNull();
    expect(alertPriceUnresolved).toHaveBeenCalledTimes(1);
  });

  it("still writes the event (with null cost) even if alertPriceUnresolved throws", async () => {
    const { deps, insertedRows } = makeDeps(sonnetRows, {
      alertPriceUnresolved: vi.fn(async () => {
        throw new Error("alert channel is down");
      }),
    });

    const result = await writeLlmCallEvent(deps, {
      eventId: "33333333-aaaa-aaaa-aaaa-333333333333",
      projectId: "33333333-3333-3333-3333-333333333333",
      provider: "anthropic",
      model: "some-unreleased-model",
      inputTokens: 100,
      outputTokens: 100,
      occurredAt: "2026-08-20T00:00:00Z",
      status: "success",
    });

    expect(result.costUsd).toBeNull();
    expect(result.id).toBe("row-1");
    expect(insertedRows).toHaveLength(1);
  });

  // Issue 5.4's literal stated unit test: submitting the same event
  // twice must not create a second row.
  it("submits the same event twice and asserts one row (AC1)", async () => {
    const { deps, insertedRows } = makeDeps(sonnetRows);
    const payload = {
      eventId: "44444444-aaaa-aaaa-aaaa-444444444444",
      projectId: "33333333-3333-3333-3333-333333333333",
      provider: "anthropic" as const,
      model: "claude-sonnet-5",
      inputTokens: 1500,
      outputTokens: 500,
      occurredAt: "2026-08-20T00:00:00Z",
      status: "success" as const,
    };

    const first = await writeLlmCallEvent(deps, payload);
    const second = await writeLlmCallEvent(deps, payload);

    expect(insertedRows).toHaveLength(1);
    expect(first.wasDuplicate).toBe(false);
    expect(second.wasDuplicate).toBe(true);
    // The retry must see the same canonical id and cost, not a fresh
    // (potentially different) computation.
    expect(second.id).toBe(first.id);
    expect(second.costUsd).toBe(first.costUsd);
  });

  it("two different events with different eventIds create two separate rows", async () => {
    const { deps, insertedRows } = makeDeps(sonnetRows);
    const base = {
      projectId: "33333333-3333-3333-3333-333333333333",
      provider: "anthropic" as const,
      model: "claude-sonnet-5",
      inputTokens: 100,
      outputTokens: 100,
      occurredAt: "2026-08-20T00:00:00Z",
      status: "success" as const,
    };

    await writeLlmCallEvent(deps, { ...base, eventId: "55555555-aaaa-aaaa-aaaa-555555555555" });
    await writeLlmCallEvent(deps, { ...base, eventId: "66666666-aaaa-aaaa-aaaa-666666666666" });

    expect(insertedRows).toHaveLength(2);
  });

  it("preserves status: 'error' events (no token/cost gating at the write layer)", async () => {
    const { deps, insertedRows } = makeDeps(sonnetRows);
    await writeLlmCallEvent(deps, {
      eventId: "77777777-aaaa-aaaa-aaaa-777777777777",
      projectId: "33333333-3333-3333-3333-333333333333",
      provider: "anthropic",
      model: "claude-sonnet-5",
      inputTokens: 0,
      outputTokens: 0,
      occurredAt: "2026-08-20T00:00:00Z",
      status: "error",
    });
    expect(insertedRows[0].status).toBe("error");
  });
});
