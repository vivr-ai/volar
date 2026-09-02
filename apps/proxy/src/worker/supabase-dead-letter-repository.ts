import type { SupabaseClient } from "@supabase/supabase-js";
import type { DeadLetterRow } from "./dead-letter.js";

// Issue 7.4: real Supabase-backed wiring for writing a dead-letter row.
// Unlike every other worker adapter in this codebase, this one is a
// plain `.from(table).insert(...)` call, not `.rpc(...)` -- no
// SECURITY DEFINER wrapper needed, because
// public.ingestion_dead_letters (this issue's own migration) is a
// plain public-schema table, not something living in the pgmq schema
// that PostgREST can't already see.

export function createSupabaseDeadLetterRepository(
  supabase: SupabaseClient,
): (row: DeadLetterRow) => Promise<void> {
  return async function insertDeadLetter(row: DeadLetterRow): Promise<void> {
    const { error } = await supabase.from("ingestion_dead_letters").insert({
      msg_id: row.msgId,
      event_id: row.eventId,
      project_id: row.projectId,
      message: row.message,
      failure_reason: row.failureReason,
      error_detail: row.errorDetail,
      attempts: row.attempts,
      enqueued_at: row.enqueuedAt,
    });

    if (error) {
      throw new Error(`Failed to insert dead-letter row for msg_id=${row.msgId}: ${error.message}`);
    }
  };
}
