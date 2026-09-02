import { describe, it, expect } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { createSupabaseDeadLetterRepository } from "./supabase-dead-letter-repository.js";

// Real-network integration test for issue 7.4's dead-letter write path.
// Writes an actual row into public.ingestion_dead_letters, confirms it
// landed with the expected columns, then deletes it. Skipped unless
// SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are set (see
// apps/proxy/.env.example) -- matching every other *.live.test.ts in
// this codebase.
//
// Deliberately does NOT attempt to drive a message through 5 real
// dequeue cycles to actually trigger dead-lettering end-to-end -- with
// a 30s default visibility timeout, that would take minutes per run and
// buys little over what's already covered: run-worker-cycle.test.ts
// proves the *decision* logic (when a message gets dead-lettered) with
// fast in-memory fakes, and this test proves the *write* itself works
// against the real table/RLS -- the same split already used for the
// enqueue (7.2) and dequeue/archive (7.3) RPC paths.
//
// Run manually with real values, e.g.:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//   pnpm --filter @volar/proxy exec vitest run src/worker/supabase-dead-letter-repository.live.test.ts

const hasLiveCreds = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);

describe.skipIf(!hasLiveCreds)("createSupabaseDeadLetterRepository (live Supabase)", () => {
  it("writes a real dead-letter row, then cleans it up", async () => {
    const supabase = createClient(
      process.env.SUPABASE_URL as string,
      process.env.SUPABASE_SERVICE_ROLE_KEY as string,
    );
    const insertDeadLetter = createSupabaseDeadLetterRepository(supabase);

    const probeMsgId = Math.floor(Math.random() * 1_000_000_000);
    await insertDeadLetter({
      msgId: probeMsgId,
      eventId: "live-test-event",
      projectId: "33333333-3333-3333-3333-333333333333",
      message: { eventId: "live-test-event", provider: "cohere" },
      failureReason: "invalid",
      errorDetail: "provider: Invalid option (live test probe)",
      attempts: 5,
      enqueuedAt: "2026-08-20T00:00:00.000Z",
    });

    const { data: row, error } = await supabase
      .from("ingestion_dead_letters")
      .select("id, msg_id, event_id, failure_reason, attempts")
      .eq("msg_id", probeMsgId)
      .single();

    expect(error).toBeNull();
    expect(row?.event_id).toBe("live-test-event");
    expect(row?.failure_reason).toBe("invalid");
    expect(row?.attempts).toBe(5);

    if (row) {
      const { error: deleteError } = await supabase.from("ingestion_dead_letters").delete().eq("id", row.id);
      expect(deleteError).toBeNull();
    }
  });
});
