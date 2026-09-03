import type { IngestionEventPayload } from "@volar/shared";
import type { ScheduledRequest } from "./build-schedule.js";
import type { ProvisionedProject } from "./provision-fixtures.js";

// Issue 7.5: thin I/O adapter that actually fires a pre-built schedule
// (build-schedule.ts) over the network. No decision logic lives here --
// matches this project's usual pure/adapter split (rate-limiter.ts,
// dead-letter.ts, and now build-schedule.ts/reconcile.ts above).

export interface PostBatch {
  (url: string, apiKey: string, events: IngestionEventPayload[]): Promise<{ status: number }>;
}

export interface DispatchOutcome {
  projectIndex: number;
  atMs: number;
  status: number;
  ok: boolean;
}

export interface BurstRunResult {
  sentEventIds: string[];
  outcomes: DispatchOutcome[];
}

/**
 * Fires every request in `schedule` against `targetUrl`, grouping by
 * `atMs` so requests meant to fire at the same simulated instant are
 * actually dispatched concurrently (Promise.all), not serially --
 * serial dispatch would silently turn "N projects bursting at once"
 * into "N projects bursting one after another", understating the real
 * concurrency this test exists to produce.
 *
 * `post` is injected (real fetch in the CLI entrypoint) so this
 * function has no hard dependency on a global fetch implementation and
 * stays swappable for a future test double if this ever needs one.
 */
export async function runBurstSchedule(
  schedule: ScheduledRequest[],
  projects: ProvisionedProject[],
  targetUrl: string,
  post: PostBatch,
): Promise<BurstRunResult> {
  const sentEventIds: string[] = [];
  const outcomes: DispatchOutcome[] = [];
  const startedAt = Date.now();

  const byTime = new Map<number, ScheduledRequest[]>();
  for (const req of schedule) {
    const bucket = byTime.get(req.atMs) ?? [];
    bucket.push(req);
    byTime.set(req.atMs, bucket);
  }

  const orderedTimes = [...byTime.keys()].sort((a, b) => a - b);

  for (const atMs of orderedTimes) {
    const waitMs = startedAt + atMs - Date.now();
    if (waitMs > 0) {
      await sleep(waitMs);
    }

    const requests = byTime.get(atMs)!;
    await Promise.all(
      requests.map(async (req) => {
        for (const event of req.events) {
          sentEventIds.push(event.event_id);
        }

        try {
          const res = await post(
            `${targetUrl}/v1/events`,
            projects[req.projectIndex].plaintextKey,
            req.events,
          );
          outcomes.push({ projectIndex: req.projectIndex, atMs, status: res.status, ok: res.status === 202 });
        } catch {
          outcomes.push({ projectIndex: req.projectIndex, atMs, status: 0, ok: false });
        }
      }),
    );
  }

  return { sentEventIds, outcomes };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
