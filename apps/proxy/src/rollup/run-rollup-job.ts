import { computeTargetDateUtc } from "./compute-target-date.js";

// Issue 8.1 (Epic 8): the rollup job's own orchestration -- start/end/
// success/failure logging (AC2) wrapped around whatever the actual
// aggregation work is. Deliberately a thin, injectable shell: issue 8.2
// replaces `runAggregationForDate` with the real aggregation query and
// issue 8.3's idempotent upsert into daily_cost_rollups; this file's
// logging/error-handling contract doesn't change when that happens.
// Same two-layer split (pure orchestration here, thin real-work adapter
// elsewhere) as every other piece of this codebase's worker/ingestion
// code.

export interface RollupJobDeps {
  /**
   * Issue 8.1 ships a no-op stub (see no-op-aggregation.ts) so this
   * scaffold is genuinely runnable end-to-end today. Issue 8.2 replaces
   * it with the real aggregation+upsert.
   */
  runAggregationForDate: (dateUtc: string) => Promise<{ rowsWritten: number }>;
  /** Defaults to () => new Date(). Tests inject a fixed clock. */
  now?: () => Date;
}

export type RollupJobLog = (event: string, fields?: Record<string, unknown>) => void;

export interface RollupJobResult {
  status: "success" | "failure";
  dateUtc: string;
  startedAt: string;
  endedAt: string;
  rowsWritten?: number;
  error?: string;
}

/**
 * Runs exactly one rollup pass for "yesterday" (UTC), logging start/end/
 * success/failure (AC2) via the injected logger. Never throws -- any
 * error from runAggregationForDate is caught, logged, and reflected in
 * the returned result's `status`/`error` fields instead, so the caller
 * (the cron entrypoint, rollup.ts) can decide the process exit code
 * without this function needing to know about process.exit itself --
 * same reasoning as run-worker-loop.ts's own error handling.
 */
export async function runRollupJob(
  deps: RollupJobDeps,
  log: RollupJobLog,
): Promise<RollupJobResult> {
  const now = deps.now ?? (() => new Date());
  const dateUtc = computeTargetDateUtc(now());
  const startedAt = now().toISOString();

  log("rollup_job_started", { dateUtc, startedAt });

  try {
    const { rowsWritten } = await deps.runAggregationForDate(dateUtc);
    const endedAt = now().toISOString();
    log("rollup_job_completed", { dateUtc, startedAt, endedAt, rowsWritten });
    return { status: "success", dateUtc, startedAt, endedAt, rowsWritten };
  } catch (error) {
    const endedAt = now().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    log("rollup_job_failed", { dateUtc, startedAt, endedAt, error: message });
    return { status: "failure", dateUtc, startedAt, endedAt, error: message };
  }
}
