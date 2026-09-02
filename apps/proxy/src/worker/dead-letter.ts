import type { DequeuedMessage } from "./queue-message.js";
import type { ProcessMessageOutcome } from "./process-queue-message.js";

// Issue 7.4 (Epic 7): dead-letter handling for a message that keeps
// failing. Pure helpers only -- no I/O -- same layering as every other
// piece of this worker; supabase-dead-letter-repository.ts is the thin
// adapter that actually writes a row.

export interface DeadLetterRow {
  msgId: number;
  /** Best-effort, pulled straight out of the raw (possibly malformed)
   * message -- null if it wasn't present or wasn't a string. Never
   * throws trying to extract this; see buildDeadLetterRow. */
  eventId: string | null;
  projectId: string | null;
  message: unknown;
  failureReason: "invalid" | "failed";
  errorDetail: string | null;
  /** pgmq's own read_ct at the moment this row is built -- "N
   * attempts" per this issue's AC1, not a separately-tracked counter. */
  attempts: number;
  enqueuedAt: string;
}

/**
 * True once a message has been read `maxAttempts` times (pgmq's own
 * per-message read_ct, already returned by dequeue_ingestion_events) --
 * i.e. this dequeue is itself the last attempt this worker will make
 * before giving up. Only ever consulted for a non-"inserted" outcome
 * (see run-worker-cycle.ts): a message that succeeds is never a
 * dead-letter candidate no matter how many prior attempts it took.
 */
export function isFinalAttempt(dequeued: DequeuedMessage, maxAttempts: number): boolean {
  return dequeued.readCt >= maxAttempts;
}

/**
 * Builds the exact row to insert into public.ingestion_dead_letters.
 * Deliberately tolerant of a `dequeued.message` that isn't even a
 * plain object -- that's precisely the kind of input this table exists
 * to capture, so extracting eventId/projectId can never itself throw
 * and block the dead-letter write (see the migration's own comment on
 * why the table's columns are similarly unconstrained).
 */
export function buildDeadLetterRow(
  dequeued: DequeuedMessage,
  outcome: Extract<ProcessMessageOutcome, { outcome: "invalid" | "failed" }>,
): DeadLetterRow {
  const raw = isPlainObject(dequeued.message) ? dequeued.message : null;
  const eventId = raw && typeof raw.eventId === "string" ? raw.eventId : null;
  const projectId = raw && typeof raw.projectId === "string" ? raw.projectId : null;

  return {
    msgId: dequeued.msgId,
    eventId,
    projectId,
    message: dequeued.message,
    failureReason: outcome.outcome,
    errorDetail: outcome.outcome === "invalid" ? outcome.error : errorToString(outcome.error),
    attempts: dequeued.readCt,
    enqueuedAt: dequeued.enqueuedAt,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorToString(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
