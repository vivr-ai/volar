import { describe, it, expect } from "vitest";
import { buildBurstSchedule } from "./build-schedule.js";
import type { BurstLoadTestConfig } from "./config.js";

function configFor(overrides: Partial<BurstLoadTestConfig> = {}): BurstLoadTestConfig {
  return {
    projectCount: 3,
    requestIntervalMs: 1000,
    normalBatchSize: 5,
    burstBatchSize: 50,
    durationMs: 3000,
    targetUrl: "https://example.test",
    ...overrides,
  };
}

describe("buildBurstSchedule", () => {
  it("produces one request per project per interval tick", () => {
    const schedule = buildBurstSchedule(configFor());
    // durationMs 3000 / requestIntervalMs 1000 -> ticks at 0, 1000, 2000
    // (3 ticks) * 3 projects = 9 requests.
    expect(schedule).toHaveLength(9);
  });

  it("covers every project index at every tick", () => {
    const schedule = buildBurstSchedule(configFor());
    const ticks = [0, 1000, 2000];
    for (const atMs of ticks) {
      const projectIndexesAtTick = schedule
        .filter((req) => req.atMs === atMs)
        .map((req) => req.projectIndex)
        .sort();
      expect(projectIndexesAtTick).toEqual([0, 1, 2]);
    }
  });

  it("gives every request exactly burstBatchSize events", () => {
    const schedule = buildBurstSchedule(configFor({ burstBatchSize: 7 }));
    for (const req of schedule) {
      expect(req.events).toHaveLength(7);
    }
  });

  it("gives every event across the whole schedule a unique event_id", () => {
    const schedule = buildBurstSchedule(configFor());
    const allIds = schedule.flatMap((req) => req.events.map((e) => e.event_id));
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  it("uses an injected eventIdGenerator when supplied (for deterministic tests)", () => {
    let counter = 0;
    const schedule = buildBurstSchedule(configFor({ projectCount: 1, durationMs: 1000, burstBatchSize: 2 }), () => `id-${counter++}`);
    const ids = schedule.flatMap((req) => req.events.map((e) => e.event_id));
    expect(ids).toEqual(["id-0", "id-1"]);
  });

  it("produces zero requests when durationMs is 0", () => {
    const schedule = buildBurstSchedule(configFor({ durationMs: 0 }));
    expect(schedule).toHaveLength(0);
  });
});
