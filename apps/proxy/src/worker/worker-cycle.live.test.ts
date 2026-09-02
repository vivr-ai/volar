import { describe, it, expect } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { createSupabaseEnqueueEvent } from "../ingestion/supabase-queue-repository.js";
import { createSupabaseEventWriteDeps } from "../ingestion/supabase-event-repository.js";
import { alertPriceUnresolvedViaConsole } from "../ingestion/alerts.js";
import { writeLlmCallEvent } from "../ingestion/write-llm-call-event.js";
import { createSupabaseWorkerQueueDeps } from "./supabase-worker-queue-repository.js";
import { processQueueMessage } from "./process-queue-message.js";
import { runWorkerCycle } from "./run-worker-cycle.js";

// Issue 7.3, AC3's literal stated test: "End-to-end test: enqueue a
// message, assert a row appears." Real-network integration test --
// enqueues a real message via issue 7.2's RPC, runs one real worker
// cycle (dequeue -> validate -> cost-compute -> insert -> archive)
// against the live project, and confirms the row actually landed in
// llm_call_events with the correct hand-calculated cost, then cleans
// up both the inserted row and archived queue message. Skipped unless
// SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY/TEST_PROJECT_ID are set (see
// apps/proxy/.env.example), matching every other *.live.test.ts in
// this codebase.
//
// Run manually with real values, e.g.:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//   TEST_PROJECT_ID=33333333-3333-3333-3333-333333333333 \
//   pnpm --filter @volar/proxy exec vitest run src/worker/worker-cycle.live.test.ts

const hasLiveCreds = Boolean(
  process.env.SUPABASE_URL &&
    process.env.SUPABASE_SERVICE_ROLE_KEY &&
    process.env.TEST_PROJECT_ID,
);

describe.skipIf(!hasLiveCreds)("worker cycle end-to-end (live Supabase)", () => {
  it("enqueues a message and one worker cycle later, a row exists in llm_call_events", async () => {
    const supabase = createClient(
      process.env.SUPABASE_URL as string,
      process.env.SUPABASE_SERVICE_ROLE_KEY as string,
    );
    const enqueueEvent = createSupabaseEnqueueEvent(supabase);
    const queueDeps = createSupabaseWorkerQueueDeps(supabase);
    const writeDeps = {
      ...createSupabaseEventWriteDeps(supabase),
      alertPriceUnresolved: alertPriceUnresolvedViaConsole,
    };

    const eventId = crypto.randomUUID();
    // Real seeded Claude Sonnet 5 v1 price (same fixture used by
    // write-llm-call-event.live.test.ts): 1000*0.0020/1k + 500*0.0100/1k
    // = 0.002 + 0.005 = 0.007
    await enqueueEvent({
      eventId,
      projectId: process.env.TEST_PROJECT_ID as string,
      provider: "anthropic",
      model: "claude-sonnet-5",
      inputTokens: 1000,
      outputTokens: 500,
      occurredAt: "2026-08-20T00:00:00Z",
      status: "success",
    });

    const cycleResult = await runWorkerCycle(
      {
        dequeueMessages: queueDeps.dequeueMessages,
        archiveMessage: queueDeps.archiveMessage,
        processMessage: (msg) =>
          processQueueMessage({ writeLlmCallEvent: (payload) => writeLlmCallEvent(writeDeps, payload) }, msg),
      },
      { visibilityTimeoutSeconds: 30, batchSize: 10 },
    );

    expect(cycleResult.inserted).toBeGreaterThanOrEqual(1);
    expect(cycleResult.failed).toBe(0);
    expect(cycleResult.invalid).toBe(0);

    const { data: row, error } = await supabase
      .from("llm_call_events")
      .select("id, computed_cost_usd, event_id")
      .eq("event_id", eventId)
      .single();

    expect(error).toBeNull();
    expect(row?.computed_cost_usd).toBe("0.007");

    // Clean up: delete the row this test created.
    if (row) {
      const { error: deleteError } = await supabase.from("llm_call_events").delete().eq("id", row.id);
      expect(deleteError).toBeNull();
    }
  });
});
