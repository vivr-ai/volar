import { runWorkerCycle, type WorkerCycleConfig, type WorkerCycleDeps } from "./run-worker-cycle.js";

// Issue 7.3: turns one "dequeue -> validate -> cost-compute -> insert"
// pass (run-worker-cycle.ts) into a continuously-running loop -- the
// "processes messages continuously" half of AC1. Deliberately its own
// thin layer above runWorkerCycle rather than folded into it, so
// run-worker-cycle.ts's unit tests never need fake timers/sleeps just
// to test one cycle's dequeue/archive bookkeeping.
//
// AC2 ("worker restarts cleanly and resumes without losing in-flight
// messages") is *not* implemented by anything in this file -- it's a
// property of pgmq's visibility-timeout design (issue 7.1) plus
// run-worker-cycle.ts's per-message archive-only-on-success behavior
// (see that file's comment). This loop's only job re: AC2 is to expose
// a clean `stop()` so a graceful shutdown (e.g. Railway sending SIGTERM
// before a redeploy) can ask the loop to finish its *current* cycle and
// then actually exit, rather than being killed mid-cycle every time --
// nicer for logs and slightly kinder to in-flight work, even though an
// ungraceful kill is already safe by design.

export type WorkerLoopDeps = WorkerCycleDeps;

export interface WorkerLoopConfig extends WorkerCycleConfig {
  /** How long to wait before polling again after a cycle that found
   * nothing to do -- avoids hammering the database with an empty
   * dequeue call in a tight loop when the queue is idle. */
  emptyPollDelayMs: number;
}

export type WorkerLog = (event: string, fields?: Record<string, unknown>) => void;

export interface WorkerLoopHandle {
  /** Signals the loop to stop after its current cycle finishes -- does
   * not itself wait for that; await `stopped` for that. */
  stop: () => void;
  /** Resolves once the loop has actually exited. */
  stopped: Promise<void>;
}

/**
 * Starts the loop immediately (fire-and-forget internally) and returns
 * a handle for the caller to later request a graceful stop. Never
 * throws on its own -- every error from a single cycle is caught,
 * logged via `log`, and treated the same as an empty cycle (wait
 * `emptyPollDelayMs`, then try again), so one bad cycle (e.g. a
 * transient network blip talking to Supabase) never kills the whole
 * worker process.
 */
export function startWorkerLoop(
  deps: WorkerLoopDeps,
  config: WorkerLoopConfig,
  log: WorkerLog = () => {},
): WorkerLoopHandle {
  let stopping = false;
  let resolveStopped!: () => void;
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });

  async function loop(): Promise<void> {
    log("worker_started", {
      batchSize: config.batchSize,
      visibilityTimeoutSeconds: config.visibilityTimeoutSeconds,
      emptyPollDelayMs: config.emptyPollDelayMs,
    });

    while (!stopping) {
      let sawWork = false;
      try {
        const result = await runWorkerCycle(deps, config);
        sawWork = result.dequeued > 0;
        if (sawWork) {
          log("worker_cycle_completed", result as unknown as Record<string, unknown>);
        }
      } catch (error) {
        log("worker_cycle_error", { err: error instanceof Error ? error.message : String(error) });
      }

      if (!sawWork && !stopping) {
        await sleep(config.emptyPollDelayMs);
      }
    }

    log("worker_stopped");
    resolveStopped();
  }

  void loop();

  return {
    stop: () => {
      stopping = true;
    },
    stopped,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
