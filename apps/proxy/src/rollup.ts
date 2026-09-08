import { runRollupJob } from "./rollup/run-rollup-job.js";
import { runNoOpAggregation } from "./rollup/no-op-aggregation.js";

// Issue 8.1 (Epic 8): daily rollup job entrypoint -- the literal
// "scheduled job" the backlog describes. Sibling to index.ts/worker.ts
// (same dist/ compilation, same "real entrypoint, thin wiring only"
// shape), but unlike those two, this process is meant to run once and
// exit, not run forever -- see the cron reasoning below.
//
// Run via Railway's own per-service cron schedule (see this issue's
// delivery write-up for the exact service/schedule), or manually at any
// time (AC3) via `pnpm --filter @volar/proxy dev:rollup` (local,
// unbuilt) or `pnpm --filter @volar/proxy start:rollup` (compiled --
// the same command Railway's cron service runs).
//
// Judgment call, flagged per the Working Agreement: the backlog's own
// story text for issue 8.1 says "Supabase Edge Function cron or Vercel
// Cron" -- written before this project settled on Railway as its
// actual deployment target (see docs/CI.md's Railway section, and
// issue 7.5's write-up). Using Railway's native cronSchedule field on
// its own dedicated service instead avoids introducing a second
// hosting platform for one scheduled job -- the same "don't add new
// infrastructure the founder has to separately provision/pay for/
// monitor" reasoning already applied to issue 7.1's pgmq-over-Upstash
// choice and issue 7.3's in-process-worker choice. See this issue's
// write-up for the exact Railway service configuration.
//
// A Railway cron-scheduled service runs its start command once per
// tick and exits, unlike an always-on web/worker service -- so this
// file explicitly calls process.exit() with the run's real outcome,
// making success/failure visible in Railway's own deployment history
// (useful groundwork for issue 8.4's alerting, even though 8.4's actual
// retry/alert logic isn't built yet -- this issue only needs the
// scaffold to exist).

function structuredLog(event: string, fields: Record<string, unknown> = {}): void {
  // Same plain console.log + JSON convention as worker.ts, for the same
  // reason: no Fastify instance to hang a pino logger off of in a
  // standalone script.
  console.log(JSON.stringify({ level: "info", time: Date.now(), event, ...fields }));
}

async function main(): Promise<void> {
  const result = await runRollupJob({ runAggregationForDate: runNoOpAggregation }, structuredLog);
  process.exit(result.status === "failure" ? 1 : 0);
}

void main();
