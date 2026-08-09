import { describe, it, expect, vi } from "vitest";
import type { PriceTableRow } from "@volar/shared";
import { writeLlmCallEvent, type WriteLlmCallEventDeps } from "./write-llm-call-event.js";

// Real seeded PriceTable data (issue 4.2), same fixture used by issue
// 4.4's tests -- two Claude Sonnet 5 versions with a real price change.
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

function makeDeps(priceRows: readonly PriceTableRow[]): {
  deps: WriteLlmCallEventDeps;
  insertedRows: unknown[];
} {
  const insertedRows: unknown[] = [];
  const deps: WriteLlmCallEventDeps = {
    fetchPriceRows: vi.fn(async () => priceRows),
    insertEvent: vi.fn(async (row) => {
      insertedRows.push(row);
      return { id: "11111111-1111-1111-1111-111111111111" };
    }),
  };
  return { deps, insertedRows };
}

describe("writeLlmCallEvent", () => {
  it("resolves the correct price version and computes cost (hand-calculated)", async () => {
    // 1500 input @ $0.0020/1k = 0.003, 500 output @ $0.0100/1k = 0.005 -> 0.008
    const { deps, insertedRows } = makeDeps(sonnetRows);

    const result = await writeLlmCallEvent(deps, {
      projectId: "33333333-3333-3333-3333-333333333333",
      provider: "anthropic",
      model: "claude-sonnet-5",
      inputTokens: 1500,
      outputTokens: 500,
      occurredAt: "2026-08-20T00:00:00Z",
      status: "success",
    });

    expect(result.costUsd).toBe("0.008");
    expect(deps.fetchPriceRows).toHaveBeenCalledWith("anthropic", "claude-sonnet-5");
    expect(insertedRows).toEqual([
      {
        project_id: "33333333-3333-3333-3333-333333333333",
        provider: "anthropic",
        model: "claude-sonnet-5",
        input_tokens: 1500,
        output_tokens: 500,
        computed_cost_usd: "0.008",
        customer_id: null,
        feature_id: null,
        occurred_at: "2026-08-20T00:00:00.000Z",
        status: "success",
      },
    ]);
  });

  it("resolves the newer price version once its effective_from has passed", async () => {
    const { deps } = makeDeps(sonnetRows);
    const result = await writeLlmCallEvent(deps, {
      projectId: "33333333-3333-3333-3333-333333333333",
      provider: "anthropic",
      model: "claude-sonnet-5",
      inputTokens: 1000,
      outputTokens: 1000,
      occurredAt: "2026-09-15T00:00:00Z",
      status: "success",
    });
    // 1 * 0.003 + 1 * 0.015 = 0.018
    expect(result.costUsd).toBe("0.018");
  });

  it("passes through customer_id and feature_id tags when present", async () => {
    const { deps, insertedRows } = makeDeps(sonnetRows);
    await writeLlmCallEvent(deps, {
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
    const row = insertedRows[0] as { customer_id: string; feature_id: string };
    expect(row.customer_id).toBe("cust-42");
    expect(row.feature_id).toBe("summarizer");
  });

  // AC1: insert always carries a computed_cost_usd or explicit null --
  // never a silently wrong number, and the write must still succeed.
  it("stores a null cost (and still inserts) when no price resolves for the model", async () => {
    const { deps, insertedRows } = makeDeps(sonnetRows);
    const result = await writeLlmCallEvent(deps, {
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
    expect((insertedRows[0] as { computed_cost_usd: unknown }).computed_cost_usd).toBeNull();
  });

  it("stores a null cost when occurred_at predates the earliest known price", async () => {
    const { deps } = makeDeps(sonnetRows);
    const result = await writeLlmCallEvent(deps, {
      projectId: "33333333-3333-3333-3333-333333333333",
      provider: "anthropic",
      model: "claude-sonnet-5",
      inputTokens: 100,
      outputTokens: 100,
      occurredAt: "2020-01-01T00:00:00Z",
      status: "success",
    });
    expect(result.costUsd).toBeNull();
  });

  it("preserves status: 'error' events (no token/cost gating at the write layer)", async () => {
    const { deps, insertedRows } = makeDeps(sonnetRows);
    await writeLlmCallEvent(deps, {
      projectId: "33333333-3333-3333-3333-333333333333",
      provider: "anthropic",
      model: "claude-sonnet-5",
      inputTokens: 0,
      outputTokens: 0,
      occurredAt: "2026-08-20T00:00:00Z",
      status: "error",
    });
    expect((insertedRows[0] as { status: string }).status).toBe("error");
  });
});
