import type { ValidatedEventPayload, WriteLlmCallEventResult } from "../ingestion/write-llm-call-event.js";
import { queuedEventMessageSchema, type DequeuedMessage } from "./queue-message.js";

// Issue 7.3: the "validate -> cost-compute -> insert" half of this
// issue's title (dequeue itself is run-worker-cycle.ts's job, one level
// up). Pure orchestration -- same two-layer split as every other
// ingestion piece in this codebase -- so it's unit-testable against a
// plain in-memory fake of writeLlmCallEvent, no DB/queue involved.

export interface ProcessQueueMessageDeps {
  /** Issue 5.2's function, pre-bound to its real deps by the caller
   * (worker.ts) -- this module only needs "give me a validated payload,
   * get back the write outcome," not writeLlmCallEvent's own dependency
   * list (fetchPriceRows/insertEvent/alertPriceUnresolved). */
  writeLlmCallEvent: (payload: ValidatedEventPayload) => Promise<WriteLlmCallEventResult>;
}

export type ProcessMessageOutcome =
  | { outcome: "inserted"; msgId: number; wasDuplicate: boolean }
  | { outcome: "invalid"; msgId: number; error: string }
  | { outcome: "failed"; msgId: number; error: unknown };

/**
 * Judgment call (flagged per the Working Agreement): neither an
 * "invalid" nor a "failed" outcome causes this function (or its caller,
 * run-worker-cycle.ts) to archive the message. Only "inserted" does.
 * That means a message that can never succeed -- a genuinely malformed
 * payload, or a real, persistent write failure -- keeps becoming
 * visible again after its visibility timeout and gets retried
 * indefinitely, rather than being silently dropped. That is *exactly*
 * the "looping forever" failure mode issue 7.4 ("Dead-letter handling
 * for repeatedly failing events") is scoped to fix, per its own
 * description -- 7.4's stated AC is "no event is ever silently
 * discarded without a trace," which this function already guarantees
 * today (every outcome is reported, nothing is ever archived-and-lost
 * without a corresponding "inserted" outcome); 7.4 only adds the
 * *efficiency* half (stop retrying a proven poison pill after N
 * attempts, using pgmq's own per-message read_ct that
 * dequeue_ingestion_events already returns). Building that cap now
 * would be scope creep into an issue the backlog deliberately separated
 * out with its own dependency on this one.
 */
export async function processQueueMessage(
  deps: ProcessQueueMessageDeps,
  dequeued: DequeuedMessage,
): Promise<ProcessMessageOutcome> {
  const parsed = queuedEventMessageSchema.safeParse(dequeued.message);

  if (!parsed.success) {
    return {
      outcome: "invalid",
      msgId: dequeued.msgId,
      error: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
    };
  }

  try {
    const result = await deps.writeLlmCallEvent(parsed.data);
    return { outcome: "inserted", msgId: dequeued.msgId, wasDuplicate: result.wasDuplicate };
  } catch (error) {
    return { outcome: "failed", msgId: dequeued.msgId, error };
  }
}
