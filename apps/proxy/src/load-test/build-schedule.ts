import type { IngestionEventPayload } from "@volar/shared";
import { buildLoadTestEvent } from "./generate-event.js";
import type { BurstLoadTestConfig } from "./config.js";

// Issue 7.5: pure schedule builder -- no I/O, no timers, so it's
// fast-unit-testable the same way rate-limiter.ts's checkRateLimit and
// dead-letter.ts's buildDeadLetterRow are (this project's established
// "pure decision logic, thin I/O adapter" split -- see those files'
// header comments). dispatch.ts is the thin adapter that actually
// fires these requests over the network.

export interface ScheduledRequest {
  /** Milliseconds since the burst started that this request should
   * fire at. */
  atMs: number;
  /** Index into the provisioned projects/API keys array (see
   * provision-fixtures.ts) -- which simulated project this request
   * belongs to. */
  projectIndex: number;
  events: IngestionEventPayload[];
}

/**
 * Builds the full list of requests a burst run will fire: one request
 * per simulated project every `requestIntervalMs`, each carrying
 * `burstBatchSize` events, for `durationMs`. Every project fires at the
 * same simulated instants (dispatch.ts groups by `atMs` and fires each
 * instant's requests concurrently), so the schedule expresses genuine
 * concurrent burst load, not `projectCount` sequential mini-bursts.
 *
 * `eventIdGenerator` is optional and only ever supplied by tests --
 * production use always takes the real default (crypto.randomUUID()
 * inside buildLoadTestEvent), since every event needs a genuinely
 * unique id for AC2's reconciliation to mean anything.
 */
export function buildBurstSchedule(
  config: BurstLoadTestConfig,
  eventIdGenerator?: () => string,
): ScheduledRequest[] {
  const requests: ScheduledRequest[] = [];

  for (let atMs = 0; atMs < config.durationMs; atMs += config.requestIntervalMs) {
    for (let projectIndex = 0; projectIndex < config.projectCount; projectIndex++) {
      const events = Array.from({ length: config.burstBatchSize }, () =>
        buildLoadTestEvent({ eventId: eventIdGenerator?.() }),
      );
      requests.push({ atMs, projectIndex, events });
    }
  }

  return requests;
}
