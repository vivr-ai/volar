import { describe, it, expect } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { createSupabaseEnqueueEvent } from "./supabase-queue-repository.js";

// Real-network integration test for issue 7.2's enqueue wrapper --
// enqueues an actual message onto pgmq.q_ingestion_events via the real
// public.enqueue_ingestion_event() RPC, then purges it. Skipped unless
// SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY/TEST_PROJECT_ID are set (see
// apps/proxy/.env.example), matching the precedent set by
// write-llm-call-event.live.test.ts for the write path -- most local/
// dev/CI environments won't have real Supabase network access or
// shouldn't be enqueueing test messages onto a shared project by
// default.
//
// This exercises the actual TypeScript adapter (createSupabaseEnqueueEvent,
// what apps/proxy/src/index.ts wires into the real server), not just raw
// SQL -- the raw-SQL checks (including the anon-access bug found and
// fixed while closing this issue) are documented separately in
// docs/RLS.md's "Ingestion queue enqueue wrapper (issue 7.2)" section.
//
// Run manually with real values, e.g.:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//   TEST_PROJECT_ID=33333333-3333-3333-3333-333333333333 \
//   pnpm --filter @volar/proxy exec vitest run src/ingestion/supabase-queue-repository.live.test.ts
//
// No automated cleanup: unlike llm_call_events (a plain public table
// reachable via supabase-js's .from()), pgmq's queue tables live outside
// the public schema and are deliberately not exposed via any RPC this
// codebase ships (the whole point of issue 7.2's wrapper is to expose
// exactly one narrow operation -- enqueue -- not general pgmq access).
// So this test leaves one message in pgmq.q_ingestion_events on every
// run. Whoever runs this manually should purge it afterward via the
// Supabase MCP or SQL editor:
//   select pgmq.purge_queue('ingestion_events');
// (the same command used to clean up after every manual verification
// pass recorded in docs/RLS.md).

const hasLiveCreds = Boolean(
  process.env.SUPABASE_URL &&
    process.env.SUPABASE_SERVICE_ROLE_KEY &&
    process.env.TEST_PROJECT_ID,
);

describe.skipIf(!hasLiveCreds)("createSupabaseEnqueueEvent (live Supabase)", () => {
  it("enqueues a real message via the RPC wrapper and returns a real msgId", async () => {
    const supabase = createClient(
      process.env.SUPABASE_URL as string,
      process.env.SUPABASE_SERVICE_ROLE_KEY as string,
    );
    const enqueueEvent = createSupabaseEnqueueEvent(supabase);

    const eventId = crypto.randomUUID();
    const result = await enqueueEvent({
      eventId,
      projectId: process.env.TEST_PROJECT_ID as string,
      provider: "anthropic",
      model: "claude-sonnet-5",
      inputTokens: 1000,
      outputTokens: 500,
      occurredAt: "2026-08-20T00:00:00Z",
      status: "success",
    });

    expect(typeof result.msgId).toBe("number");
    expect(result.msgId).toBeGreaterThan(0);
    // See this file's header comment: no automated cleanup is possible
    // from here (pgmq isn't reachable via supabase-js beyond this one
    // wrapper) -- purge pgmq.q_ingestion_events manually after running
    // this test.
  });
});
