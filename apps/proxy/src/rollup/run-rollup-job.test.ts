import { describe, it, expect } from "vitest";
import { runRollupJob, type RollupJobDeps } from "./run-rollup-job.js";

const FIXED_NOW = new Date("2026-09-05T01:00:00.000Z");

function loggerSpy(): { log: (event: string, fields?: Record<string, unknown>) => void; calls: Array<{ event: string; fields?: Record<string, unknown> }> } {
  const calls: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  return {
    log: (event, fields) => {
      calls.push({ event, fields });
    },
    calls,
  };
}

describe("runRollupJob", () => {
  it("logs start then completed, and returns a success result, on a successful run", async () => {
    const { log, calls } = loggerSpy();
    const deps: RollupJobDeps = {
      runAggregationForDate: async () => ({ rowsWritten: 42 }),
      now: () => FIXED_NOW,
    };

    const result = await runRollupJob(deps, log);

    expect(result.status).toBe("success");
    expect(result.dateUtc).toBe("2026-09-04");
    expect(result.rowsWritten).toBe(42);
    expect(calls.map((c) => c.event)).toEqual(["rollup_job_started", "rollup_job_completed"]);
  });

  it("passes computeTargetDateUtc's result (yesterday, UTC) to runAggregationForDate", async () => {
    let receivedDate: string | undefined;
    const deps: RollupJobDeps = {
      runAggregationForDate: async (dateUtc) => {
        receivedDate = dateUtc;
        return { rowsWritten: 0 };
      },
      now: () => FIXED_NOW,
    };

    await runRollupJob(deps, () => {});

    expect(receivedDate).toBe("2026-09-04");
  });

  it("logs start then failed, and returns a failure result with the error message, when the aggregation throws", async () => {
    const { log, calls } = loggerSpy();
    const deps: RollupJobDeps = {
      runAggregationForDate: async () => {
        throw new Error("simulated aggregation failure");
      },
      now: () => FIXED_NOW,
    };

    const result = await runRollupJob(deps, log);

    expect(result.status).toBe("failure");
    expect(result.error).toBe("simulated aggregation failure");
    expect(result.rowsWritten).toBeUndefined();
    expect(calls.map((c) => c.event)).toEqual(["rollup_job_started", "rollup_job_failed"]);
  });

  it("stringifies a non-Error thrown value rather than throwing itself", async () => {
    const deps: RollupJobDeps = {
      runAggregationForDate: async () => {
        throw "a plain string failure";
      },
      now: () => FIXED_NOW,
    };

    const result = await runRollupJob(deps, () => {});

    expect(result.status).toBe("failure");
    expect(result.error).toBe("a plain string failure");
  });

  it("defaults to the real clock when now is not injected", async () => {
    const deps: RollupJobDeps = {
      runAggregationForDate: async () => ({ rowsWritten: 0 }),
    };

    const result = await runRollupJob(deps, () => {});

    // Just confirms it runs without throwing and produces a plausible
    // date -- not asserting an exact value, since the real clock isn't
    // controllable from a test.
    expect(result.status).toBe("success");
    expect(result.dateUtc).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
