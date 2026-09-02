import { describe, it, expect } from "vitest";
import { processQueueMessage } from "./process-queue-message.js";
import type { DequeuedMessage } from "./queue-message.js";

const VALID_MESSAGE = {
  eventId: "11111111-aaaa-aaaa-aaaa-111111111111",
  projectId: "33333333-3333-3333-3333-333333333333",
  provider: "anthropic",
  model: "claude-sonnet-5",
  inputTokens: 100,
  outputTokens: 50,
  occurredAt: "2026-08-09T00:00:00.000Z",
  status: "success",
};

function dequeuedFor(message: unknown, msgId = 1): DequeuedMessage {
  return {
    msgId,
    readCt: 1,
    enqueuedAt: "2026-08-09T00:00:00.000Z",
    vt: "2026-08-09T00:00:30.000Z",
    message,
  };
}

describe("processQueueMessage", () => {
  it("inserts a valid message and reports the outcome, including wasDuplicate", async () => {
    const outcome = await processQueueMessage(
      { writeLlmCallEvent: async () => ({ id: "row-1", costUsd: "0.007", wasDuplicate: false }) },
      dequeuedFor(VALID_MESSAGE, 42),
    );

    expect(outcome).toEqual({ outcome: "inserted", msgId: 42, wasDuplicate: false });
  });

  it("passes the exact validated payload through to writeLlmCallEvent, camelCase and all", async () => {
    let received: unknown;
    await processQueueMessage(
      {
        writeLlmCallEvent: async (payload) => {
          received = payload;
          return { id: "row-1", costUsd: null, wasDuplicate: false };
        },
      },
      dequeuedFor({ ...VALID_MESSAGE, customerId: "cust-1", featureId: "summarizer" }),
    );

    expect(received).toEqual({
      eventId: "11111111-aaaa-aaaa-aaaa-111111111111",
      projectId: "33333333-3333-3333-3333-333333333333",
      provider: "anthropic",
      model: "claude-sonnet-5",
      inputTokens: 100,
      outputTokens: 50,
      customerId: "cust-1",
      featureId: "summarizer",
      occurredAt: "2026-08-09T00:00:00.000Z",
      status: "success",
    });
  });

  it("reports wasDuplicate: true when writeLlmCallEvent reports a duplicate (issue 5.4 dedupe)", async () => {
    const outcome = await processQueueMessage(
      { writeLlmCallEvent: async () => ({ id: "row-1", costUsd: "0.007", wasDuplicate: true }) },
      dequeuedFor(VALID_MESSAGE, 7),
    );

    expect(outcome).toEqual({ outcome: "inserted", msgId: 7, wasDuplicate: true });
  });

  it("reports 'invalid' (never throws) for a message missing a required field, without calling writeLlmCallEvent", async () => {
    let called = false;
    const withoutEventId: Record<string, unknown> = { ...VALID_MESSAGE };
    delete withoutEventId.eventId;

    const outcome = await processQueueMessage(
      {
        writeLlmCallEvent: async () => {
          called = true;
          return { id: "row-1", costUsd: null, wasDuplicate: false };
        },
      },
      dequeuedFor(withoutEventId, 5),
    );

    expect(outcome.outcome).toBe("invalid");
    expect(outcome.msgId).toBe(5);
    expect(called).toBe(false);
    if (outcome.outcome === "invalid") {
      expect(outcome.error).toContain("eventId");
    }
  });

  it("reports 'invalid' for an unsupported provider", async () => {
    const outcome = await processQueueMessage(
      { writeLlmCallEvent: async () => ({ id: "row-1", costUsd: null, wasDuplicate: false }) },
      dequeuedFor({ ...VALID_MESSAGE, provider: "cohere" }),
    );

    expect(outcome.outcome).toBe("invalid");
  });

  it("reports 'invalid' for a completely non-object message (e.g. a stray string or null)", async () => {
    const outcome = await processQueueMessage(
      { writeLlmCallEvent: async () => ({ id: "row-1", costUsd: null, wasDuplicate: false }) },
      dequeuedFor("not-an-object", 9),
    );

    expect(outcome).toMatchObject({ outcome: "invalid", msgId: 9 });
  });

  it("reports 'failed' (not 'invalid') when writeLlmCallEvent itself throws, and never lets the error escape", async () => {
    const simulatedError = new Error("simulated DB failure");
    const outcome = await processQueueMessage(
      {
        writeLlmCallEvent: async () => {
          throw simulatedError;
        },
      },
      dequeuedFor(VALID_MESSAGE, 3),
    );

    expect(outcome).toEqual({ outcome: "failed", msgId: 3, error: simulatedError });
  });
});
