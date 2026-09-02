import { describe, it, expect } from "vitest";
import { runWorkerCycle, type WorkerCycleDeps } from "./run-worker-cycle.js";
import type { DequeuedMessage } from "./queue-message.js";
import type { ProcessMessageOutcome } from "./process-queue-message.js";

const CONFIG = { visibilityTimeoutSeconds: 30, batchSize: 10, maxAttempts: 5 };

function messageFor(msgId: number, readCt = 1): DequeuedMessage {
  return {
    msgId,
    readCt,
    enqueuedAt: "2026-08-09T00:00:00.000Z",
    vt: "2026-08-09T00:00:30.000Z",
    message: { eventId: `evt-${msgId}`, projectId: "proj-1" },
  };
}

function noopDeadLetter(): Promise<void> {
  return Promise.resolve();
}

describe("runWorkerCycle", () => {
  it("returns all-zero counts and calls nothing else when the queue is empty", async () => {
    let archiveCalls = 0;
    let processCalls = 0;
    let deadLetterCalls = 0;
    const deps: WorkerCycleDeps = {
      dequeueMessages: async () => [],
      archiveMessage: async () => {
        archiveCalls++;
      },
      processMessage: async () => {
        processCalls++;
        return { outcome: "inserted", msgId: 1, wasDuplicate: false };
      },
      deadLetterMessage: async () => {
        deadLetterCalls++;
      },
    };

    const result = await runWorkerCycle(deps, CONFIG);

    expect(result).toEqual({ dequeued: 0, inserted: 0, invalid: 0, failed: 0, deadLettered: 0, archiveFailed: 0 });
    expect(archiveCalls).toBe(0);
    expect(processCalls).toBe(0);
    expect(deadLetterCalls).toBe(0);
  });

  it("archives every successfully-inserted message and counts it", async () => {
    const archived: number[] = [];
    const deps: WorkerCycleDeps = {
      dequeueMessages: async () => [messageFor(1), messageFor(2)],
      archiveMessage: async (msgId) => {
        archived.push(msgId);
      },
      processMessage: async (msg) => ({ outcome: "inserted", msgId: msg.msgId, wasDuplicate: false }),
      deadLetterMessage: noopDeadLetter,
    };

    const result = await runWorkerCycle(deps, CONFIG);

    expect(result).toEqual({ dequeued: 2, inserted: 2, invalid: 0, failed: 0, deadLettered: 0, archiveFailed: 0 });
    expect(archived).toEqual([1, 2]);
  });

  it("does not archive or dead-letter an 'invalid' outcome below maxAttempts", async () => {
    let archiveCalls = 0;
    let deadLetterCalls = 0;
    const deps: WorkerCycleDeps = {
      dequeueMessages: async () => [messageFor(1, 1)],
      archiveMessage: async () => {
        archiveCalls++;
      },
      processMessage: async (msg) => ({ outcome: "invalid", msgId: msg.msgId, error: "bad shape" }),
      deadLetterMessage: async () => {
        deadLetterCalls++;
      },
    };

    const result = await runWorkerCycle(deps, CONFIG);

    expect(result).toEqual({ dequeued: 1, inserted: 0, invalid: 1, failed: 0, deadLettered: 0, archiveFailed: 0 });
    expect(archiveCalls).toBe(0);
    expect(deadLetterCalls).toBe(0);
  });

  it("does not archive or dead-letter a 'failed' outcome below maxAttempts", async () => {
    let archiveCalls = 0;
    let deadLetterCalls = 0;
    const deps: WorkerCycleDeps = {
      dequeueMessages: async () => [messageFor(1, 1)],
      archiveMessage: async () => {
        archiveCalls++;
      },
      processMessage: async (msg) => ({ outcome: "failed", msgId: msg.msgId, error: new Error("boom") }),
      deadLetterMessage: async () => {
        deadLetterCalls++;
      },
    };

    const result = await runWorkerCycle(deps, CONFIG);

    expect(result).toEqual({ dequeued: 1, inserted: 0, invalid: 0, failed: 1, deadLettered: 0, archiveFailed: 0 });
    expect(archiveCalls).toBe(0);
    expect(deadLetterCalls).toBe(0);
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
      dequeueMessages: async () => [1, 2, 3, 4].map((id) => messageFor(id, 1)),
      archiveMessage: async (msgId) => {
        archived.push(msgId);
      },
      processMessage: async (msg) => outcomesByMsgId[msg.msgId],
      deadLetterMessage: noopDeadLetter,
    };

    const result = await runWorkerCycle(deps, CONFIG);

    expect(result).toEqual({ dequeued: 4, inserted: 2, invalid: 1, failed: 1, deadLettered: 0, archiveFailed: 0 });
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
      deadLetterMessage: noopDeadLetter,
    };

    const result = await runWorkerCycle(deps, CONFIG);

    expect(result).toEqual({ dequeued: 2, inserted: 2, invalid: 0, failed: 0, deadLettered: 0, archiveFailed: 1 });
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
      deadLetterMessage: noopDeadLetter,
    };

    await runWorkerCycle(deps, { visibilityTimeoutSeconds: 45, batchSize: 7, maxAttempts: 5 });

    expect(receivedArgs).toEqual([45, 7]);
  });

  // Issue 7.4
  describe("dead-lettering (issue 7.4)", () => {
    it("dead-letters and archives an 'invalid' message once it reaches maxAttempts, not before", async () => {
      const deadLettered: unknown[] = [];
      const archived: number[] = [];
      const deps: WorkerCycleDeps = {
        dequeueMessages: async () => [messageFor(1, 5)], // readCt === maxAttempts
        archiveMessage: async (msgId) => {
          archived.push(msgId);
        },
        processMessage: async (msg) => ({ outcome: "invalid", msgId: msg.msgId, error: "still bad" }),
        deadLetterMessage: async (row) => {
          deadLettered.push(row);
        },
      };

      const result = await runWorkerCycle(deps, CONFIG);

      expect(result).toEqual({ dequeued: 1, inserted: 0, invalid: 0, failed: 0, deadLettered: 1, archiveFailed: 0 });
      expect(archived).toEqual([1]);
      expect(deadLettered).toHaveLength(1);
      expect(deadLettered[0]).toMatchObject({
        msgId: 1,
        eventId: "evt-1",
        projectId: "proj-1",
        failureReason: "invalid",
        errorDetail: "still bad",
        attempts: 5,
      });
    });

    it("dead-letters and archives a 'failed' message once it reaches maxAttempts", async () => {
      const deadLettered: unknown[] = [];
      const archived: number[] = [];
      const simulatedError = new Error("persistent DB failure");
      const deps: WorkerCycleDeps = {
        dequeueMessages: async () => [messageFor(9, 7)], // beyond maxAttempts, not just at it
        archiveMessage: async (msgId) => {
          archived.push(msgId);
        },
        processMessage: async (msg) => ({ outcome: "failed", msgId: msg.msgId, error: simulatedError }),
        deadLetterMessage: async (row) => {
          deadLettered.push(row);
        },
      };

      const result = await runWorkerCycle(deps, CONFIG);

      expect(result.deadLettered).toBe(1);
      expect(result.failed).toBe(0);
      expect(archived).toEqual([9]);
      expect(deadLettered[0]).toMatchObject({ msgId: 9, failureReason: "failed", errorDetail: "persistent DB failure", attempts: 7 });
    });

    it("never dead-letters (or archives) an 'inserted' outcome, no matter how high readCt is", async () => {
      let deadLetterCalls = 0;
      const archived: number[] = [];
      const deps: WorkerCycleDeps = {
        dequeueMessages: async () => [messageFor(1, 10)], // way past maxAttempts
        archiveMessage: async (msgId) => {
          archived.push(msgId);
        },
        processMessage: async (msg) => ({ outcome: "inserted", msgId: msg.msgId, wasDuplicate: false }),
        deadLetterMessage: async () => {
          deadLetterCalls++;
        },
      };

      const result = await runWorkerCycle(deps, CONFIG);

      expect(result).toEqual({ dequeued: 1, inserted: 1, invalid: 0, failed: 0, deadLettered: 0, archiveFailed: 0 });
      expect(deadLetterCalls).toBe(0);
      expect(archived).toEqual([1]); // archived as an ordinary successful insert, not via the dead-letter path
    });

    it("falls back to ordinary invalid/failed counting (message left un-archived) when deadLetterMessage itself throws", async () => {
      let archiveCalls = 0;
      const deps: WorkerCycleDeps = {
        dequeueMessages: async () => [messageFor(1, 5)],
        archiveMessage: async () => {
          archiveCalls++;
        },
        processMessage: async (msg) => ({ outcome: "invalid", msgId: msg.msgId, error: "still bad" }),
        deadLetterMessage: async () => {
          throw new Error("dead-letter insert failed");
        },
      };

      const result = await runWorkerCycle(deps, CONFIG);

      expect(result).toEqual({ dequeued: 1, inserted: 0, invalid: 1, failed: 0, deadLettered: 0, archiveFailed: 0 });
      expect(archiveCalls).toBe(0);
    });

    it("does not archive when the dead-letter row succeeds but the follow-up archive call throws, and still falls back to invalid/failed counting", async () => {
      const deps: WorkerCycleDeps = {
        dequeueMessages: async () => [messageFor(1, 5)],
        archiveMessage: async () => {
          throw new Error("archive RPC failed");
        },
        processMessage: async (msg) => ({ outcome: "invalid", msgId: msg.msgId, error: "still bad" }),
        deadLetterMessage: noopDeadLetter,
      };

      const result = await runWorkerCycle(deps, CONFIG);

      // Not counted as a successful dead-letter (the message is still
      // live on the queue, about to be retried) -- falls back to the
      // ordinary invalid count instead, same as any other failure.
      expect(result).toEqual({ dequeued: 1, inserted: 0, invalid: 1, failed: 0, deadLettered: 0, archiveFailed: 0 });
    });

    it("processes a mixed batch where some messages dead-letter and others don't", async () => {
      const outcomesByMsgId: Record<number, ProcessMessageOutcome> = {
        1: { outcome: "invalid", msgId: 1, error: "bad" }, // readCt 1 -- not yet
        2: { outcome: "invalid", msgId: 2, error: "bad" }, // readCt 5 -- dead-letter
        3: { outcome: "inserted", msgId: 3, wasDuplicate: false },
        4: { outcome: "failed", msgId: 4, error: new Error("boom") }, // readCt 5 -- dead-letter
      };
      const readCtByMsgId: Record<number, number> = { 1: 1, 2: 5, 3: 1, 4: 5 };
      const archived: number[] = [];
      const deadLettered: number[] = [];
      const deps: WorkerCycleDeps = {
        dequeueMessages: async () => [1, 2, 3, 4].map((id) => messageFor(id, readCtByMsgId[id])),
        archiveMessage: async (msgId) => {
          archived.push(msgId);
        },
        processMessage: async (msg) => outcomesByMsgId[msg.msgId],
        deadLetterMessage: async (row) => {
          deadLettered.push(row.msgId);
        },
      };

      const result = await runWorkerCycle(deps, CONFIG);

      expect(result).toEqual({ dequeued: 4, inserted: 1, invalid: 1, failed: 0, deadLettered: 2, archiveFailed: 0 });
      expect(deadLettered.sort()).toEqual([2, 4]);
      expect(archived.sort()).toEqual([2, 3, 4]);
    });
  });
});
