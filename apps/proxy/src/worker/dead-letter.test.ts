import { describe, it, expect } from "vitest";
import { isFinalAttempt, buildDeadLetterRow } from "./dead-letter.js";
import type { DequeuedMessage } from "./queue-message.js";

function dequeuedFor(overrides: Partial<DequeuedMessage> = {}): DequeuedMessage {
  return {
    msgId: 1,
    readCt: 1,
    enqueuedAt: "2026-08-09T00:00:00.000Z",
    vt: "2026-08-09T00:00:30.000Z",
    message: { eventId: "evt-1", projectId: "proj-1" },
    ...overrides,
  };
}

describe("isFinalAttempt", () => {
  it("is false below the threshold", () => {
    expect(isFinalAttempt(dequeuedFor({ readCt: 4 }), 5)).toBe(false);
  });

  it("is true exactly at the threshold", () => {
    expect(isFinalAttempt(dequeuedFor({ readCt: 5 }), 5)).toBe(true);
  });

  it("is true beyond the threshold (e.g. a delayed second worker instance)", () => {
    expect(isFinalAttempt(dequeuedFor({ readCt: 9 }), 5)).toBe(true);
  });
});

describe("buildDeadLetterRow", () => {
  it("extracts eventId/projectId from a well-formed message and captures an 'invalid' outcome", () => {
    const dequeued = dequeuedFor({ msgId: 42, readCt: 5, message: { eventId: "evt-42", projectId: "proj-42" } });
    const row = buildDeadLetterRow(dequeued, { outcome: "invalid", msgId: 42, error: "eventId: Required" });

    expect(row).toEqual({
      msgId: 42,
      eventId: "evt-42",
      projectId: "proj-42",
      message: { eventId: "evt-42", projectId: "proj-42" },
      failureReason: "invalid",
      errorDetail: "eventId: Required",
      attempts: 5,
      enqueuedAt: "2026-08-09T00:00:00.000Z",
    });
  });

  it("captures a 'failed' outcome's Error message as errorDetail", () => {
    const dequeued = dequeuedFor({ msgId: 7, readCt: 5 });
    const row = buildDeadLetterRow(dequeued, {
      outcome: "failed",
      msgId: 7,
      error: new Error("simulated DB failure"),
    });

    expect(row.failureReason).toBe("failed");
    expect(row.errorDetail).toBe("simulated DB failure");
  });

  it("stringifies a non-Error 'failed' error rather than throwing", () => {
    const dequeued = dequeuedFor();
    const row = buildDeadLetterRow(dequeued, { outcome: "failed", msgId: 1, error: "a plain string error" });

    expect(row.errorDetail).toBe("a plain string error");
  });

  it("never throws when the raw message is not an object at all -- eventId/projectId come back null", () => {
    const dequeued = dequeuedFor({ message: "not-an-object" });
    const row = buildDeadLetterRow(dequeued, { outcome: "invalid", msgId: 1, error: "bad shape" });

    expect(row.eventId).toBeNull();
    expect(row.projectId).toBeNull();
    expect(row.message).toBe("not-an-object");
  });

  it("never throws when the raw message is null, an array, or has non-string eventId/projectId", () => {
    for (const message of [null, [1, 2, 3], { eventId: 123, projectId: null }]) {
      const dequeued = dequeuedFor({ message });
      const row = buildDeadLetterRow(dequeued, { outcome: "invalid", msgId: 1, error: "bad shape" });
      expect(row.eventId).toBeNull();
      expect(row.projectId).toBeNull();
    }
  });

  it("preserves the exact raw message unmodified, even a malformed one", () => {
    const malformed = { eventId: "evt-1", extraJunk: { nested: true } };
    const dequeued = dequeuedFor({ message: malformed });
    const row = buildDeadLetterRow(dequeued, { outcome: "invalid", msgId: 1, error: "bad shape" });

    expect(row.message).toEqual(malformed);
  });
});
