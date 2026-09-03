import { createServiceRoleSupabaseClient } from "../ingestion/supabase-event-repository.js";
import {
  provisionLoadTestFixtures,
  teardownLoadTestFixtures,
} from "./provision-fixtures.js";
import { buildBurstSchedule } from "./build-schedule.js";
import { runBurstSchedule } from "./dispatch.js";
import { pollForReconciliation } from "./poll-persisted-events.js";
import { reconcileBurst } from "./reconcile.js";
import { DEFAULT_BURST_LOAD_TEST_CONFIG, type BurstLoadTestConfig } from "./config.js";

// Issue 7.5 (Epic 7): burst-traffic load test CLI. Thin orchestration
// only -- every piece with real logic (schedule, dispatch, reconcile,
// fixtures) is its own separately unit-testable module; this file just
// wires them together and prints a summary. Entry point is
// apps/proxy/scripts/burst-load-test.ts (a 3-line launcher outside
// tsconfig's "include": ["src"] -- see that file's own comment).
//
// Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in the environment
// (same as the deployed app itself -- createServiceRoleSupabaseClient()
// throws immediately if either is missing). Never accepts either as a
// CLI flag, so a plaintext key can't end up in shell history the way a
// flag would.
//
// AC3 says "latency stays within NFR §10.2's budget throughout" --
// worth being precise about what this script can and can't actually
// prove, a correction made while building it (see events.test.ts's
// header comment for the full history of the earlier, less precise
// framing this replaces). NFR §10.2 budgets overhead added to the
// *customer's LLM call* (50ms p95/150ms p99), and FR-6.8 has the SDK
// batch events locally and flush on its own timer, decoupled from that
// call -- so the number that actually lands in NFR §10.2's budget is
// the cost of a local in-memory push, not the network round trip this
// script measures. No SDK exists yet (Epic 9/10) to measure that real
// number.
//
// What this script *does* measure, and what AC3 is treated as meaning
// for this issue specifically (flagged here as that judgment call):
// proxy-side response time to POST /v1/events under a 10x burst,
// pulled from Railway's own request-timing data for the exact window
// this run covers -- authoritative, server-side, not this script's own
// client-side timers (which would additionally include network RTT
// between wherever this script runs and Railway, unrelated to the
// proxy's own overhead). That's a legitimate, useful signal for the
// proxy's own capacity planning (does it degrade or start erroring
// under burst load?) but it is a different quantity from NFR §10.2's
// SDK-overhead budget and must not be reported as satisfying it
// directly. This function prints the run's start/end timestamps
// specifically so that lookup can be scoped to the right window
// afterward.

function parseArgs(argv: string[]): Partial<BurstLoadTestConfig> {
  const overrides: Partial<BurstLoadTestConfig> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case "--duration-ms":
        overrides.durationMs = Number(next);
        i++;
        break;
      case "--project-count":
        overrides.projectCount = Number(next);
        i++;
        break;
      case "--request-interval-ms":
        overrides.requestIntervalMs = Number(next);
        i++;
        break;
      case "--burst-batch-size":
        overrides.burstBatchSize = Number(next);
        i++;
        break;
      case "--target-url":
        overrides.targetUrl = next;
        i++;
        break;
      default:
        throw new Error(`Unrecognized argument: ${arg}`);
    }
  }
  return overrides;
}

async function realPost(
  url: string,
  apiKey: string,
  events: unknown,
): Promise<{ status: number }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify(events),
  });
  return { status: res.status };
}

export async function runCli(argv: string[]): Promise<void> {
  const overrides = parseArgs(argv);
  const config: BurstLoadTestConfig = { ...DEFAULT_BURST_LOAD_TEST_CONFIG, ...overrides };

  console.log("Issue 7.5 burst load test starting with config:", config);

  const supabase = createServiceRoleSupabaseClient();
  const fixtures = await provisionLoadTestFixtures(supabase, config.projectCount);
  console.log(
    `Provisioned organization ${fixtures.organizationId} with ${fixtures.projects.length} projects.`,
  );

  try {
    const schedule = buildBurstSchedule(config);
    const totalEvents = schedule.reduce((sum, req) => sum + req.events.length, 0);
    console.log(
      `Schedule built: ${schedule.length} requests, ${totalEvents} events, over ${config.durationMs}ms.`,
    );

    const runStartedAt = new Date().toISOString();
    const { sentEventIds, outcomes } = await runBurstSchedule(
      schedule,
      fixtures.projects,
      config.targetUrl,
      realPost,
    );
    const runEndedAt = new Date().toISOString();

    const nonOkOutcomes = outcomes.filter((o) => !o.ok);
    console.log(
      `Dispatched ${outcomes.length} requests (${sentEventIds.length} events). ` +
        `${nonOkOutcomes.length} non-202 responses.`,
    );
    if (nonOkOutcomes.length > 0) {
      console.log("Sample non-202 outcomes:", nonOkOutcomes.slice(0, 5));
    }

    console.log("Polling for reconciliation (worker drains asynchronously)...");
    const { persistedEventIds, deadLetteredEventIds } = await pollForReconciliation(
      supabase,
      fixtures.projects.map((p) => p.projectId),
      sentEventIds.length,
      { timeoutMs: 120_000, pollIntervalMs: 3_000 },
    );

    const reconciliation = reconcileBurst(sentEventIds, persistedEventIds, deadLetteredEventIds);

    console.log("--- Issue 7.5 burst load test result ---");
    console.log(`Run window: ${runStartedAt} -> ${runEndedAt}`);
    console.log(`AC1 (burst dispatched): ${outcomes.length} requests, ${sentEventIds.length} events sent.`);
    console.log(
      `AC2 (zero events lost): sent=${reconciliation.sentCount} matched=${reconciliation.matchedCount} ` +
        `deadLettered=${reconciliation.deadLetteredCount} missing=${reconciliation.missingEventIds.length}`,
    );
    if (reconciliation.missingEventIds.length > 0) {
      console.log("Missing event_ids (sample):", reconciliation.missingEventIds.slice(0, 20));
    }
    console.log(
      `AC3 (proxy response-time under burst -- NOT the same number as NFR §10.2's SDK-overhead ` +
        `budget, see this file's header comment): pull Railway's http/deploy logs for service volar, ` +
        `environment staging, path /v1/events, over the run window above (the http-response-time ` +
        `aggregation tool may lag or be empty -- the raw "http" log stream's totalDuration field is ` +
        `the reliable fallback, per this issue's own delivery write-up).`,
    );
  } finally {
    console.log(`Tearing down organization ${fixtures.organizationId}...`);
    await teardownLoadTestFixtures(supabase, fixtures);
    console.log("Teardown complete.");
  }
}
