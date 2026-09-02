import type { DequeuedMessage } from "./queue-message.js";
import type { ProcessMessageOutcome } from "./process-queue-message.js";
import { isFinalAttempt, buildDeadLetterRow, type DeadLetterRow } from "./dead-letter.js";

// Issue 7.3: one full "dequeue -> validate -> cost-compute -> insert"
// pass -- the "dequeue" step itself, plus wiring processQueueMessage's
// per-message outcome to whether that message gets archived. Pure
// orchestration (no real Supabase/pgmq calls of its own), so it's
// unit-testable against in-memory fakes for dequeueMessages/
// archiveMessage/processMessage -- run-worker-loop.ts is the thin layer
// above this that turns "one cycle" into "cycles forever, with a poll
// delay when there was nothing to do."
//
// Issue 7.4: adds the dead-letter decision -- see the loop body below
// for exactly where a repeatedly-failing message stops being retried
// and gets moved out of the live queue instead.

export interface WorkerCycleDeps {
  dequeueMessages: (
    visibilityTimeoutSeconds: number,
    batchSize: number,
  ) => Promise<DequeuedMessage[]>;
  archiveMessage: (msgId: number) => Promise<void>;
  processMessage: (dequeued: DequeuedMessage) => Promise<ProcessMessageOutcome>;
  /** Issue 7.4: writes a row to public.ingestion_dead_letters. Called
   * only for a message that has failed (validation or write) on what
   * this cycle determines is its final allowed attempt -- see
   * isFinalAttempt/buildDeadLetterRow in dead-letter.ts. */
  deadLetterMessage: (row: DeadLetterRow) => Promise<void>;
}

export interface WorkerCycleConfig {
  /** Must comfortably exceed the worst-case time to validate + compute
   * cost + insert one full batch -- if it's too short, pgmq will make a
   * message visible to a second reader again while this cycle is still
   * legitimately working on it (a message being processed twice
   * concurrently is still safe, thanks to issue 5.4's event_id
   * idempotency, but it's wasted work worth avoiding via a sane
   * default). */
  visibilityTimeoutSeconds: number;
  /** Max messages claimed per dequeueMessages call. */
  batchSize: number;
  /** Issue 7.4, AC1's "N attempts": once a message's own pgmq read_ct
   * reaches this number and it *still* fails (validation or write),
   * it's moved to the dead-letter table instead of being left to retry
   * again. See dead-letter.ts's isFinalAttempt. */
  maxAttempts: number;
}

export interface WorkerCycleResult {
  dequeued: number;
  inserted: number;
  invalid: number;
  failed: number;
  /** Issue 7.4: messages moved to public.ingestion_dead_letters this
   * cycle -- mutually exclusive with invalid/failed above (a
   * dead-lettered message is counted here only, not double-counted). */
  deadLettered: number;
  /** Count of messages that were successfully inserted (already counted
   * in `inserted`) but whose archiveMessage call itself then threw. Not
   * a data-loss risk -- see runWorkerCycle's comment on why an
   * unarchived-but-already-inserted message is still safe -- but worth
   * surfacing separately so a persistent archive failure (e.g. a
   * misconfigured RPC grant) shows up in logs rather than hiding inside
   * an otherwise-healthy `inserted` count. */
  archiveFailed: number;
}

/**
 * Processes messages **sequentially**, one at a time, not in parallel
 * (unlike issue 7.2's enqueue-event.ts, which deliberately parallelizes
 * with Promise.allSettled). Judgment call, flagged: 7.2's parallelism
 * was justified by a real constraint -- the customer-facing HTTP
 * request is on the clock against PRD NFR §10.2's latency budget. This
 * worker has no such deadline (issue 7.3's own ACs only ask for
 * "processes messages continuously," never a throughput/latency
 * number), so the simpler, easier-to-reason-about sequential loop is
 * preferred for V1 -- it also means each message's archive happens
 * immediately after *that* message's own successful insert, not batched
 * at the end, which is what makes AC2 ("restarts cleanly ... without
 * losing in-flight messages") hold even if the process is killed
 * partway through a batch: everything before the kill is already
 * durably archived, everything from the kill onward is still safely on
 * the queue, about to become visible again. Revisit if a future load
 * test (issue 7.5) shows sequential processing can't keep up with real
 * traffic.
 */
export async function runWorkerCycle(
  deps: WorkerCycleDeps,
  config: WorkerCycleConfig,
): Promise<WorkerCycleResult> {
  const messages = await deps.dequeueMessages(config.visibilityTimeoutSeconds, config.batchSize);

  const result: WorkerCycleResult = {
    dequeued: messages.length,
    inserted: 0,
    invalid: 0,
    failed: 0,
    deadLettered: 0,
    archiveFailed: 0,
  };

  for (const message of messages) {
    const outcome = await deps.processMessage(message);

    if (outcome.outcome === "inserted") {
      result.inserted++;
      // Only a confirmed insert gets archived -- see
      // process-queue-message.ts's header comment for why "invalid" and
      // "failed" outcomes deliberately do not (short of the dead-letter
      // path below). Wrapped in its own try/catch so an archive failure
      // (the row is already safely written -- only the queue
      // bookkeeping failed) doesn't abort processing of the rest of
      // this batch; the message will simply become visible again and
      // get reprocessed, which issue 5.4's event_id idempotency makes a
      // safe no-op rather than a duplicate row.
      try {
        await deps.archiveMessage(outcome.msgId);
      } catch {
        result.archiveFailed++;
      }
      continue;
    }

    // Issue 7.4: a message that has now failed (validation or write) on
    // what pgmq's own read_ct says is its final allowed attempt gets
    // moved to the dead-letter table instead of being left to retry
    // forever. Deliberately re-checked on *every* failing attempt
    // (not just "the Nth"), using >= rather than ===, so a message
    // somehow read more times than maxAttempts (e.g. two overlapping
    // worker instances) still gets caught rather than slipping past the
    // threshold.
    if (isFinalAttempt(message, config.maxAttempts)) {
      try {
        await deps.deadLetterMessage(buildDeadLetterRow(message, outcome));
        // Only remove it from the live queue once the dead-letter row
        // is confirmed written -- see this issue's own AC3 ("no event
        // is ever silently discarded without a trace"). If either call
        // throws, the message is deliberately left un-archived and
        // falls through to the ordinary invalid/failed counting below,
        // so it simply gets picked up and re-attempted next cycle
        // rather than being lost.
        await deps.archiveMessage(message.msgId);
        result.deadLettered++;
        continue;
      } catch {
        // Fall through to ordinary invalid/failed counting.
      }
    }

    if (outcome.outcome === "invalid") {
      result.invalid++;
    } else {
      result.failed++;
    }
  }

  return result;
}
