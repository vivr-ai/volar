import { createServiceRoleSupabaseClient, createSupabaseEventWriteDeps } from "./ingestion/supabase-event-repository.js";
import { alertPriceUnresolvedViaConsole } from "./ingestion/alerts.js";
import { writeLlmCallEvent } from "./ingestion/write-llm-call-event.js";
import { createSupabaseWorkerQueueDeps } from "./worker/supabase-worker-queue-repository.js";
import { createSupabaseDeadLetterRepository } from "./worker/supabase-dead-letter-repository.js";
import { processQueueMessage } from "./worker/process-queue-message.js";
import { startWorkerLoop, type WorkerLoopConfig } from "./worker/run-worker-loop.js";

// Issue 7.3 (Epic 7): standalone worker entrypoint -- the literal
// "background worker process" the backlog describes, runnable on its
// own (`pnpm --filter @volar/proxy start:worker` / `dist/worker.js`).
//
// Deployment judgment call, flagged: this file is independently
// runnable as its own OS process, but index.ts *also* starts the exact
// same loop in-process by default (see index.ts's WORKER_ENABLED
// handling) rather than requiring Vivek to stand up a second Railway
// service for V1. Reasoning, same as issue 7.1's pgmq-over-Upstash call:
// avoid new infrastructure a non-technical founder would need to
// provision/pay for/monitor separately, when the simpler option (one
// Node process, one Fastify server plus a non-blocking async loop
// alongside it) already satisfies every stated AC -- "processes
// messages continuously" and "restarts cleanly" don't require a
// separate process, only a correctly-designed one (see
// run-worker-cycle.ts's comment on why AC2 holds regardless). This file
// still exists as a clean, independently-deployable unit specifically
// so splitting it into its own Railway service later -- e.g. if the
// worker's DB load ever needs to be isolated from the HTTP server's, or
// if Railway's per-process resource limits become a concern -- is a
// zero-code-change operational decision: point a second service at
// `pnpm --filter @volar/proxy start:worker` and set WORKER_ENABLED=false
// on the existing web service.

const VISIBILITY_TIMEOUT_SECONDS = Number(process.env.WORKER_VISIBILITY_TIMEOUT_SECONDS ?? 30);
const BATCH_SIZE = Number(process.env.WORKER_BATCH_SIZE ?? 10);
const EMPTY_POLL_DELAY_MS = Number(process.env.WORKER_EMPTY_POLL_DELAY_MS ?? 2000);
// Issue 7.4, AC1's "N attempts". 5 is a judgment call, flagged: at the
// default 30s visibility timeout, that's at least ~2.5 minutes of
// retrying a transient failure (a brief Supabase blip, a momentary
// network hiccup) before giving up -- generous enough not to dead-letter
// something that would have succeeded on its own, without leaving a
// genuine poison pill retrying for hours. Revisit once real failure
// patterns are observed (Epic 19 observability).
const MAX_ATTEMPTS = Number(process.env.WORKER_MAX_ATTEMPTS ?? 5);

export const WORKER_LOOP_CONFIG: WorkerLoopConfig = {
  visibilityTimeoutSeconds: VISIBILITY_TIMEOUT_SECONDS,
  batchSize: BATCH_SIZE,
  emptyPollDelayMs: EMPTY_POLL_DELAY_MS,
  maxAttempts: MAX_ATTEMPTS,
};

function structuredLog(event: string, fields: Record<string, unknown> = {}): void {
  // Deliberately plain console.log + JSON, not pino: this file is a
  // standalone script (no Fastify instance to hang a logger off of, the
  // way index.ts gets one for free), and pulling in pino as a new
  // direct dependency just for this one file's log lines was judged not
  // worth it for V1 -- the shape (event/time/fields) still matches the
  // structured logging convention every other part of this codebase
  // uses, so log aggregation (Epic 19) can treat it the same way.
  console.log(JSON.stringify({ level: "info", time: Date.now(), event, ...fields }));
}

/**
 * Builds the real, Supabase-backed worker loop deps + starts the loop.
 * Exported (not just called at module load) so index.ts can start this
 * exact same loop in-process without duplicating any wiring -- see
 * index.ts's WORKER_ENABLED handling.
 */
export function startRealWorkerLoop() {
  const supabase = createServiceRoleSupabaseClient();
  const queueDeps = createSupabaseWorkerQueueDeps(supabase);
  const writeDeps = {
    ...createSupabaseEventWriteDeps(supabase),
    alertPriceUnresolved: alertPriceUnresolvedViaConsole,
  };
  const deadLetterMessage = createSupabaseDeadLetterRepository(supabase);

  return startWorkerLoop(
    {
      dequeueMessages: queueDeps.dequeueMessages,
      archiveMessage: queueDeps.archiveMessage,
      processMessage: (message) =>
        processQueueMessage({ writeLlmCallEvent: (payload) => writeLlmCallEvent(writeDeps, payload) }, message),
      deadLetterMessage,
    },
    WORKER_LOOP_CONFIG,
    structuredLog,
  );
}

// Only auto-start when this file is actually run directly (`node
// dist/worker.js` / `tsx src/worker.ts`), not when index.ts imports
// startRealWorkerLoop() to run it in-process instead.
const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  const handle = startRealWorkerLoop();

  const shutdown = () => {
    structuredLog("worker_shutdown_requested");
    handle.stop();
    void handle.stopped.then(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
