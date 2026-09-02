import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startWorkerLoop, type WorkerLoopDeps } from "./run-worker-loop.js";
import type { DequeuedMessage } from "./queue-message.js";

const CONFIG = { visibilityTimeoutSeconds: 30, batchSize: 10, emptyPollDelayMs: 1000 };

function messageFor(msgId: number): DequeuedMessage {
  return { msgId, readCt: 1, enqueuedAt: "2026-08-09T00:00:00.000Z", vt: "2026-08-09T00:00:30.000Z", message: {} };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("startWorkerLoop", () => {
  it("logs worker_started immediately and worker_stopped only after stop() + stopped resolves", async () => {
    const logs: string[] = [];
    const deps: WorkerLoopDeps = {
      dequeueMessages: async () => [],
      archiveMessage: async () => {},
      processMessage: async (msg) => ({ outcome: "inserted", msgId: msg.msgId, wasDuplicate: false }),
    };

    const handle = startWorkerLoop(deps, CONFIG, (event) => logs.push(event));
    // Let the first (synchronous-ish) cycle run before asserting.
    await vi.advanceTimersByTimeAsync(0);

    expect(logs).toContain("worker_started");
    expect(logs).not.toContain("worker_stopped");

    handle.stop();
    await vi.advanceTimersByTimeAsync(CONFIG.emptyPollDelayMs);
    await handle.stopped;

    expect(logs).toContain("worker_stopped");
  });

  it("polls repeatedly on an empty queue, waiting emptyPollDelayMs between cycles", async () => {
    let dequeueCalls = 0;
    const deps: WorkerLoopDeps = {
      dequeueMessages: async () => {
        dequeueCalls++;
        return [];
      },
      archiveMessage: async () => {},
      processMessage: async (msg) => ({ outcome: "inserted", msgId: msg.msgId, wasDuplicate: false }),
    };

    const handle = startWorkerLoop(deps, CONFIG, () => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(dequeueCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(CONFIG.emptyPollDelayMs);
    expect(dequeueCalls).toBe(2);

    await vi.advanceTimersByTimeAsync(CONFIG.emptyPollDelayMs);
    expect(dequeueCalls).toBe(3);

    handle.stop();
    await vi.advanceTimersByTimeAsync(CONFIG.emptyPollDelayMs);
    await handle.stopped;
  });

  it("drains back-to-back without waiting when a cycle found messages", async () => {
    let dequeueCalls = 0;
    const deps: WorkerLoopDeps = {
      // First call returns a message (should trigger an immediate
      // re-poll, no emptyPollDelayMs wait); every call after is empty.
      dequeueMessages: async () => {
        dequeueCalls++;
        return dequeueCalls === 1 ? [messageFor(1)] : [];
      },
      archiveMessage: async () => {},
      processMessage: async (msg) => ({ outcome: "inserted", msgId: msg.msgId, wasDuplicate: false }),
    };

    const handle = startWorkerLoop(deps, CONFIG, () => {});
    // No fake-timer advance needed for the second call -- it must
    // happen without waiting on emptyPollDelayMs at all, driven purely
    // by microtask/promise resolution.
    await vi.advanceTimersByTimeAsync(0);

    expect(dequeueCalls).toBe(2);

    handle.stop();
    await vi.advanceTimersByTimeAsync(CONFIG.emptyPollDelayMs);
    await handle.stopped;
  });

  it("logs worker_cycle_error and keeps looping when a cycle throws, rather than crashing", async () => {
    let dequeueCalls = 0;
    const events: string[] = [];
    const deps: WorkerLoopDeps = {
      dequeueMessages: async () => {
        dequeueCalls++;
        if (dequeueCalls === 1) {
          throw new Error("simulated transient failure");
        }
        return [];
      },
      archiveMessage: async () => {},
      processMessage: async (msg) => ({ outcome: "inserted", msgId: msg.msgId, wasDuplicate: false }),
    };

    const handle = startWorkerLoop(deps, CONFIG, (event) => events.push(event));
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toContain("worker_cycle_error");

    // The loop is still alive and keeps polling after the error.
    await vi.advanceTimersByTimeAsync(CONFIG.emptyPollDelayMs);
    expect(dequeueCalls).toBe(2);

    handle.stop();
    await vi.advanceTimersByTimeAsync(CONFIG.emptyPollDelayMs);
    await handle.stopped;
  });

  it("stop() lets the current cycle finish rather than aborting it mid-flight", async () => {
    let archiveCalled = false;
    const deps: WorkerLoopDeps = {
      dequeueMessages: async () => [messageFor(1)],
      archiveMessage: async () => {
        archiveCalled = true;
      },
      processMessage: async (msg) => ({ outcome: "inserted", msgId: msg.msgId, wasDuplicate: false }),
    };

    const handle = startWorkerLoop(deps, CONFIG, () => {});
    handle.stop(); // requested before the first cycle has even run
    await vi.advanceTimersByTimeAsync(0);
    await handle.stopped;

    // The in-flight cycle still completed (dequeued -> processed ->
    // archived) even though stop() was called first -- stop only
    // prevents the *next* cycle from starting.
    expect(archiveCalled).toBe(true);
  });
});
