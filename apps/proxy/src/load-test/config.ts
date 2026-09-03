// Issue 7.5 (Epic 7): burst-traffic load test configuration.
//
// Judgment call, flagged per the Working Agreement: the backlog's own
// issue text asks for "burst traffic" at "10x normal event rate for 5
// minutes" as an example, but the frozen PRD/backlog defines neither
// "normal event rate" nor how a burst should be shaped relative to it.
// Two numbers already exist elsewhere in this codebase that this issue
// can borrow instead of inventing new ones from nothing:
//
//   - FR-6.8 (via issue 6.5's rate-limiter.ts header comment): the SDK
//     batches locally and flushes "every 2-5 seconds" under sustained
//     load. `requestIntervalMs: 2000` reproduces that literally -- one
//     request every 2s per simulated project, the fastest cadence
//     FR-6.8 itself describes as normal.
//   - issue 6.5's DEFAULT_INGESTION_RATE_LIMIT_CONFIG: 300 requests/60s
//     (5 req/s) per API key. A naive "10x the request rate" burst
//     design would push a single key from ~0.5 req/s (FR-6.8's normal)
//     to ~5 req/s -- landing exactly on 6.5's already-tested rate-limit
//     ceiling and testing that instead of this issue's actual subject
//     (the queue + worker path, issue 7.3/7.4). So request *cadence*
//     stays flat at the FR-6.8 rate for both "normal" and "burst";
//     what scales 10x is the *batch size* per request
//     (`burstBatchSize = 10 * normalBatchSize`) -- exactly how a real
//     SDK would in fact produce more events without producing more
//     requests, since FR-6.8 batches "N events, whichever comes
//     first". This keeps the two rate-limit layers (6.5's per-request
//     limit, this issue's per-event burst) cleanly separated instead of
//     conflated.
//   - `projectCount: 10` spreads the burst across 10 independently
//     rate-limited API keys (see provision-fixtures.ts) so the
//     *aggregate* event volume this test drives is large even though no
//     single key ever approaches its own request-rate ceiling --
//     matching "a design partner running multiple concurrent instances"
//     from 6.5's own reasoning, just deliberately dialed up for this
//     issue's burst scenario instead of steady-state traffic.
//
// `durationMs` defaults to the backlog's literal "5 minutes" example.
// The actual verification run performed for this issue's delivery
// write-up uses a shortened `durationMs` (passed via `--duration-ms`),
// clearly labeled a verification run, not this default -- see the
// write-up for the exact numbers and why a full 5-minute/75k-event run
// wasn't performed live in this session.

export interface BurstLoadTestConfig {
  /** Number of simulated projects/API keys the burst is spread across. */
  projectCount: number;
  /** Milliseconds between each simulated project's own requests. */
  requestIntervalMs: number;
  /** Events per request under normal (non-burst) traffic. Only used as
   * the baseline burstBatchSize is documented relative to -- this load
   * test always drives the burst rate, never the normal rate, since
   * proving the system survives 10x is the point of issue 7.5. */
  normalBatchSize: number;
  /** Events per request during the burst -- the actual "10x normal
   * event rate" this test drives. */
  burstBatchSize: number;
  /** Total wall-clock duration of the burst, in milliseconds. */
  durationMs: number;
  /** Base URL of the deployed proxy under test, e.g.
   * https://volar-staging.up.railway.app (no trailing slash). */
  targetUrl: string;
}

const NORMAL_BATCH_SIZE = 5;
const BURST_MULTIPLIER = 10;

export const DEFAULT_BURST_LOAD_TEST_CONFIG: BurstLoadTestConfig = {
  projectCount: 10,
  requestIntervalMs: 2000,
  normalBatchSize: NORMAL_BATCH_SIZE,
  burstBatchSize: NORMAL_BATCH_SIZE * BURST_MULTIPLIER,
  durationMs: 5 * 60 * 1000,
  targetUrl: "https://volar-staging.up.railway.app",
};
