import { describe, it, expect } from "vitest";
import { runWorkerCycle, type WorkerCycleDeps } from "./run-worker-cycle.js";
import type { DequeuedMessage } from "./queue-message.js";
import type { ProcessMessageOutcome } from "./process-queue-message.js";

const CONFIG = { visibilityTimeoutSeconds: 30, batchSize: 10 };

function messageFor(msgId: number): DequeuedMessage {
  return { msgId, readCt: 1, enqueuedAt: "2026-08-09T00:00:00.000Z", vt: "2026-08-09T00:00:30.000Z", message: {} };
}

describe("runWorkerCycle", () => {
  it("returns all-zero counts and calls nothing else when the queue is empty", async () => {
    let archiveCalls = 0;
    let processCalls = 0;
    const deps: WorkerCycleDeps = {
      dequeueMessages: async () => [],
      archiveMessage: async () => {
        archiveCalls++;
      },
      processMessage: async () => {
        processCalls++;
        return { outcome: "inserted", msgId: 1, wasDuplicate: false };
      },
    };

    const result = await runWorkerCycle(deps, CONFIG);

    expect(result).toEqual({ dequeued: 0, inserted: 0, invalid: 0, failed: 0, archiveFailed: 0 });
    expect(archiveCalls).toBe(0);
    expect(processCalls).toBe(0);
  });

  it("archives every successfully-inserted message and counts it", async () => {
    const archived: number[] = [];
    const deps: WorkerCycleDeps = {
      dequeueMessages: async () => [messageFor(1), messageFor(2)],
      archiveMessage: async (msgId) => {
        archived.push(msgId);
      },
      processMessage: async (msg) => ({ outcome: "inserted", msgId: msg.msgId, wasDuplicate: false }),
    };

    const result = await runWorkerCycle(deps, CONFIG);

    expect(result).toEqual({ dequeued: 2, inserted: 2, invalid: 0, failed: 0, archiveFailed: 0 });
    expect(archived).toEqual([1, 2]);
  });

  it("does not archive an 'invalid' outcome", async () => {
    let archiveCalls = 0;
    const deps: WorkerCycleDeps = {
      dequeueMessages: async () => [messageFor(1)],
      archiveMessage: async () => {
        archiveCalls++;
      },
      processMessage: async (msg) => ({ outcome: "invalid", msgId: msg.msgId, error: "bad shape" }),
    };

    const result = await runWorkerCycle(deps, CONFIG);

    expect(result).toEqual({ dequeued: 1, inserted: 0, invalid: 1, failed: 0, archiveFailed: 0 });
    expect(archiveCalls).toBe(0);
  });

  it("does not archive a 'failed' outcome", async () => {
    let archiveCalls = 0;
    const deps: WorkerCycleDeps = {
      dequeueMessages: async () => [messageFor(1)],
      archiveMessage: async () => {
        archiveCalls++;
      },
      processMessage: async (msg) => ({ outcome: "failed", msgId: msg.msgId, error: new Error("boom") }),
    };

    const result = await runWorkerCycle(deps, CONFIG);

    expect(result).toEqual({ dequeued: 1, inserted: 0, invalid: 0, failed: 1, archiveFailed: 0 });
    expect(archiveCalls).toBe(0);
  });

  it("processes messages in a mixed batch independently and reports each outcome correctly", async () => {
    const outcomesByMsgId: Record<number, ProcessMessageOutcome> = {
      1: { outcome: "inserted", msgId: 1, wasDuplicate: false },
      2: { outcome: "invalid", msgId: 2, error: "bad" },
      3: { outcome: "failed", msgId: 3, error: new Error("boom") },
      4: { outcome: "inserted", msgId: 4, wasDuplicate: true },
    };
    const archived: number[] = [];
    const deps: WorkerCycleDeps = {
      dequeueMessages: async () => [1, 2, 3, 4].map(messageFor),
      archiveMessage: async (msgId) => {
        archived.push(msgId);
      },
      processMessage: async (msg) => outcomesByMsgId[msg.msgId],
    };

    const result = await runWorkerCycle(deps, CONFIG);

    expect(result).toEqual({ dequeued: 4, inserted: 2, invalid: 1, failed: 1, archiveFailed: 0 });
    expect(archived.sort()).toEqual([1, 4]);
  });

  it("does not abort the rest of the batch when archiveMessage throws, and reports archiveFailed", async () => {
    let secondMessageProcessed = false;
    const deps: WorkerCycleDeps = {
      dequeueMessages: async () => [messageFor(1), messageFor(2)],
      archiveMessage: async (msgId) => {
        if (msgId === 1) {
          throw new Error("archive RPC failed");
        }
      },
      processMessage: async (msg) => {
        if (msg.msgId === 2) secondMessageProcessed = true;
        return { outcome: "inserted", msgId: msg.msgId, wasDuplicate: false };
      },
    };

    const result = await runWorkerCycle(deps, CONFIG);

    expect(result).toEqual({ dequeued: 2, inserted: 2, invalid: 0, failed: 0, archiveFailed: 1 });
    expect(secondMessageProcessed).toBe(true);
  });

  it("passes visibilityTimeoutSeconds and batchSize through to dequeueMessages unchanged", async () => {
    let receivedArgs: [number, number] | undefined;
    const deps: WorkerCycleDeps = {
      dequeueMessages: async (vt, batchSize) => {
        receivedArgs = [vt, batchSize];
        return [];
      },
      archiveMessage: async () => {},
      processMessage: async (msg) => ({ outcome: "inserted", msgId: msg.msgId, wasDuplicate: false }),
    };

    await runWorkerCycle(deps, { visibilityTimeoutSeconds: 45, batchSize: 7 });

    expect(receivedArgs).toEqual([45, 7]);
  });
});
