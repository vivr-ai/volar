import { describe, it, expect, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { writeLlmCallEvent } from "./write-llm-call-event.js";
import { createSupabaseEventWriteDeps } from "./supabase-event-repository.js";

// Real-network integration test for issues 5.2/5.3/5.4 -- writes an
// actual row against a live Supabase project, then deletes it. Skipped
// unless SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY/TEST_PROJECT_ID are set
// (see apps/proxy/.env.example), since most local/dev/CI environments
// won't have real Supabase network access or shouldn't be writing test
// rows into a shared project by default.
//
// Run manually with real values, e.g.:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//   TEST_PROJECT_ID=33333333-3333-3333-3333-333333333333 \
//   pnpm --filter @volar/proxy exec vitest run src/ingestion/write-llm-call-event.live.test.ts

const hasLiveCreds = Boolean(
  process.env.SUPABASE_URL &&
    process.env.SUPABASE_SERVICE_ROLE_KEY &&
    process.env.TEST_PROJECT_ID,
);

describe.skipIf(!hasLiveCreds)("writeLlmCallEvent (live Supabase)", () => {
  it("writes a real row with a correctly resolved cost, then cleans up", async () => {
    const supabase = createClient(
      process.env.SUPABASE_URL as string,
      process.env.SUPABASE_SERVICE_ROLE_KEY as string,
    );
    const alertPriceUnresolved = vi.fn(async () => undefined);
    const deps = {
      ...createSupabaseEventWriteDeps(supabase),
      alertPriceUnresolved,
    };

    // Uses the real seeded Claude Sonnet 5 v1 price (issue 4.2):
    // 1000 * 0.0020/1k + 500 * 0.0100/1k = 0.002 + 0.005 = 0.007
    const result = await writeLlmCallEvent(deps, {
      eventId: crypto.randomUUID(),
      projectId: process.env.TEST_PROJECT_ID as string,
      provider: "anthropic",
      model: "claude-sonnet-5",
      inputTokens: 1000,
      outputTokens: 500,
      occurredAt: "2026-08-20T00:00:00Z",
      status: "success",
    });

    expect(result.costUsd).toBe("0.007");
    expect(result.id).toBeTruthy();
    expect(result.wasDuplicate).toBe(false);
    expect(alertPriceUnresolved).not.toHaveBeenCalled();

    const { error: deleteError } = await supabase
      .from("llm_call_events")
      .delete()
      .eq("id", result.id);
    expect(deleteError).toBeNull();
  });

  it("stores a null cost and alerts for an unresolved model, then cleans up", async () => {
    const supabase = createClient(
      process.env.SUPABASE_URL as string,
      process.env.SUPABASE_SERVICE_ROLE_KEY as string,
    );
    const alertPriceUnresolved = vi.fn(async () => undefined);
    const deps = {
      ...createSupabaseEventWriteDeps(supabase),
      alertPriceUnresolved,
    };

    const result = await writeLlmCallEvent(deps, {
      eventId: crypto.randomUUID(),
      projectId: process.env.TEST_PROJECT_ID as string,
      provider: "anthropic",
      model: "volar-live-test-unreleased-model",
      inputTokens: 10,
      outputTokens: 10,
      occurredAt: "2026-08-20T00:00:00Z",
      status: "success",
    });

    expect(result.costUsd).toBeNull();
    expect(alertPriceUnresolved).toHaveBeenCalledTimes(1);

    const { error: deleteError } = await supabase
      .from("llm_call_events")
      .delete()
      .eq("id", result.id);
    expect(deleteError).toBeNull();
  });

  // Issue 5.4: the actual DB-level idempotency guarantee, proven
  // against the real unique(event_id) constraint rather than a fake.
  it("dedupes a retried event_id against the real DB and never creates a second row", async () => {
    const supabase = createClient(
      process.env.SUPABASE_URL as string,
      process.env.SUPABASE_SERVICE_ROLE_KEY as string,
    );
    const deps = {
      ...createSupabaseEventWriteDeps(supabase),
      alertPriceUnresolved: async () => undefined,
    };

    const eventId = crypto.randomUUID();
    const payload = {
      eventId,
      projectId: process.env.TEST_PROJECT_ID as string,
      provider: "anthropic" as const,
      model: "claude-sonnet-5",
      inputTokens: 1000,
      outputTokens: 500,
      occurredAt: "2026-08-20T00:00:00Z",
      status: "success" as const,
    };

    const first = await writeLlmCallEvent(deps, payload);
    const second = await writeLlmCallEvent(deps, payload);

    expect(first.wasDuplicate).toBe(false);
    expect(second.wasDuplicate).toBe(true);
    expect(second.id).toBe(first.id);
    expect(second.costUsd).toBe(first.costUsd);

    const { count } = await supabase
      .from("llm_call_events")
      .select("id", { count: "exact", head: true })
      .eq("event_id", eventId);
    expect(count).toBe(1);

    const { error: deleteError } = await supabase
      .from("llm_call_events")
      .delete()
      .eq("id", first.id);
    expect(deleteError).toBeNull();
  });
});
