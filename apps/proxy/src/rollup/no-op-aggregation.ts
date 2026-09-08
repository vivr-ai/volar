// Issue 8.1's placeholder RollupJobDeps.runAggregationForDate. Issue
// 8.2 ("Rollup aggregation query") replaces this entirely with the real
// aggregation query against llm_call_events, and issue 8.3 adds the
// idempotent upsert into daily_cost_rollups. This stub exists purely so
// issue 8.1's scaffold (scheduling + start/end/success/failure logging
// + manual trigger) is genuinely runnable end-to-end today, without
// needing 8.2/8.3's logic to exist yet -- same "ship a real, working
// no-op now, replace it later" approach as issue 6.1's endpoint
// scaffold before real validation/auth landed on top of it.
export async function runNoOpAggregation(_dateUtc: string): Promise<{ rowsWritten: number }> {
  return { rowsWritten: 0 };
}
