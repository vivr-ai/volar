import type { SupabaseClient } from "@supabase/supabase-js";
import type { ValidatedEventPayload } from "./write-llm-call-event.js";

// Real Supabase-backed wiring for the enqueue step (issue 7.2). Calls
// the public.enqueue_ingestion_event() wrapper via supabase-js's
// .rpc() -- the first place this codebase has needed .rpc() rather
// than .from(table).select/insert/update(); every other write so far
// has been a plain table operation.
//
// Why a wrapper function exists at all, and why it's locked down to
// service_role only (including a real gap found and fixed live, not
// just assumed correct): see
// supabase/migrations/20260902081500_enqueue_ingestion_event_wrapper.sql
// and its follow-up migration, plus docs/RLS.md's "Ingestion queue
// enqueue wrapper (issue 7.2)" section for the full verification
// transcript.
//
// The message body is the *exact* ValidatedEventPayload the route
// already produced -- no re-shaping. This is deliberate: issue 7.3's
// worker ("dequeue -> validate -> cost-compute -> insert", per the
// backlog's own description) calls writeLlmCallEvent() directly with
// whatever comes back off the queue, so the queue's message shape
// needs to be exactly writeLlmCallEvent()'s existing input shape --
// nothing new to invent or re-map on the dequeue side. (Date
// instances in `occurredAt` would serialize to ISO strings
// automatically when supabase-js JSON-encodes the RPC body, though in
// practice this codebase never actually constructs a real Date there
// -- it's always the wire payload's ISO string already.)

export function createSupabaseEnqueueEvent(
  supabase: SupabaseClient,
): (payload: ValidatedEventPayload) => Promise<{ msgId: number }> {
  return async function enqueueEvent(payload: ValidatedEventPayload): Promise<{ msgId: number }> {
    const { data, error } = await supabase.rpc("enqueue_ingestion_event", {
      payload: payload as unknown as Record<string, unknown>,
    });

    if (error) {
      throw new Error(`Failed to enqueue ingestion event ${payload.eventId}: ${error.message}`);
    }

    return { msgId: data as number };
  };
}
