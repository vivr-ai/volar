import { describe, it, expect, beforeEach } from "vitest";
import type { PriceTableRow } from "@volar/shared";
import {
  writeLlmCallEvent,
  type WriteLlmCallEventDeps,
  type InsertEventOutcome,
  type LLMCallEventInsertRow,
} from "./write-llm-call-event.js";

// Integration test: exercises the full, real payload -> price
// resolution -> cost computation -> row-insert (with dedupe) path using
// an in-memory stand-in for price_table/llm_call_events instead of a
// live Postgres connection. The proxy's dev/CI sandbox has no network
// access to Supabase, so this test wires the *real* resolvePriceForEvent
// and computeCostUsd functions from @volar/shared together with fake,
// in-memory persistence rather than a live DB. See
// write-llm-call-event.live.test.ts for a real-network-gated test a
// team member can run once against an actual Supabase project (also
// verified directly against the live project as part of closing issues
// 5.2/5.3/5.4 — see the commit notes / docs/RLS.md).

const seededPriceTable: PriceTableRow[] = [
  {
    provider: "openai",
    model: "gpt-5.6-terra",
    effectiveFrom: "2026-08-07T00:00:00Z",
    version: 1,
    inputPricePer1kTokensUsd: "0.0020",
    outputPricePer1kTokensUsd: "0.0120",
  },
  {
    provider: "anthropic",
    model: "claude-opus-5",
    effectiveFrom: "2026-08-07T00:00:00Z",
    version: 1,
    inputPricePer1kTokensUsd: "0.0050",
    outputPricePer1kTokensUsd: "0.0250",
  },
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

let insertedRows: LLMCallEventInsertRow[];
let deps: WriteLlmCallEventDeps;

beforeEach(() => {
  insertedRows = [];
  const byEventId = new Map<string, InsertEventOutcome>();
  deps = {
    fetchPriceRows: async (provider, model) =>
      seededPriceTable.filter((r) => r.provider === provider && r.model === model),
    insertEvent: async (row) => {
      const existing = byEventId.get(row.event_id);
      if (existing) {
        return { ...existing, wasDuplicate: true };
      }
      insertedRows.push(row);
      const outcome: InsertEventOutcome = {
        id: `row-${insertedRows.length}`,
        costUsd: row.computed_cost_usd,
        wasDuplicate: false,
      };
      byEventId.set(row.event_id, outcome);
      return outcome;
    },
    alertPriceUnresolved: async () => undefined,
  };
});

describe("writeLlmCallEvent — full payload-to-row integration", () => {
  it("writes a batch of realistic events (both providers, tagged/untagged, one unresolved price, one retried) correctly", async () => {
    const results = await Promise.all([
      writeLlmCallEvent(deps, {
        eventId: "event-1",
        projectId: "33333333-3333-3333-3333-333333333333",
        provider: "openai",
        model: "gpt-5.6-terra",
        inputTokens: 1500,
        outputTokens: 500,
        customerId: "cust-1",
        featureId: "chatbot",
        occurredAt: "2026-08-10T12:00:00Z",
        status: "success",
      }),
      writeLlmCallEvent(deps, {
        eventId: "event-2",
        projectId: "33333333-3333-3333-3333-333333333333",
        provider: "anthropic",
        model: "claude-sonnet-5",
        inputTokens: 10_000_000,
        outputTokens: 5_000_000,
        occurredAt: "2026-09-05T00:00:00Z", // after the v2 price change
        status: "success",
      }),
      writeLlmCallEvent(deps, {
        eventId: "event-3",
        projectId: "33333333-3333-3333-3333-333333333333",
        provider: "anthropic",
        model: "claude-haiku-9000-does-not-exist",
        inputTokens: 100,
        outputTokens: 100,
        occurredAt: "2026-08-10T12:00:00Z",
        status: "success",
      }),
    ]);

    // gpt-5.6-terra: 1.5 * 0.002 + 0.5 * 0.012 = 0.003 + 0.006 = 0.009
    expect(results[0].costUsd).toBe("0.009");
    // claude-sonnet-5 v2: 10,000 * 0.003 + 5,000 * 0.015 = 30 + 75 = 105
    expect(results[1].costUsd).toBe("105");
    // unresolved model -> null, write still succeeds (AC1, issue 5.2)
    expect(results[2].costUsd).toBeNull();
    expect(insertedRows).toHaveLength(3);

    // Simulate an SDK retry resending event-1 unchanged (issue 5.4).
    const retried = await writeLlmCallEvent(deps, {
      eventId: "event-1",
      projectId: "33333333-3333-3333-3333-333333333333",
      provider: "openai",
      model: "gpt-5.6-terra",
      inputTokens: 1500,
      outputTokens: 500,
      customerId: "cust-1",
      featureId: "chatbot",
      occurredAt: "2026-08-10T12:00:00Z",
      status: "success",
    });

    expect(retried.wasDuplicate).toBe(true);
    expect(retried.id).toBe(results[0].id);
    expect(retried.costUsd).toBe(results[0].costUsd);
    // Still exactly 3 rows -- the retry did not create a 4th (no double
    // counting toward a future DailyCostRollup).
    expect(insertedRows).toHaveLength(3);

    expect(insertedRows[0].customer_id).toBe("cust-1");
    expect(insertedRows[0].feature_id).toBe("chatbot");
    expect(insertedRows[1].customer_id).toBeNull();
    expect(insertedRows[1].feature_id).toBeNull();
    expect(insertedRows[2].computed_cost_usd).toBeNull();
    expect(insertedRows[2].status).toBe("success");
  });
});
