import { describe, expect, it } from "vitest";
import { enqueueValidatedEvents } from "./enqueue-event.js";
import type { ValidatedEventPayload } from "./write-llm-call-event.js";

// Issue 7.2: unit tests for the pure orchestration function, against an
// in-memory fake enqueueEvent -- no Fastify, no Supabase. The HTTP-layer
// wiring (calling this once per request, turning failures into a 503)
// has its own coverage in ../routes/events.test.ts; this file only
// covers enqueueValidatedEvents()'s own contract.

function samplePayload(overrides: Partial<ValidatedEventPayload> = {}): ValidatedEventPayload {
  return {
    eventId: "11111111-aaaa-aaaa-aaaa-111111111111",
    projectId: "33333333-3333-3333-3333-333333333333",
    provider: "anthropic",
    model: "claude-sonnet-5",
    inputTokens: 100,
    outputTokens: 50,
    customerId: null,
    featureId: null,
    occurredAt: "2026-08-09T00:00:00.000Z",
    status: "success",
    ...overrides,
  };
}

describe("enqueueValidatedEvents", () => {
  it("returns an empty array and never calls enqueueEvent for an empty input", async () => {
    let calls = 0;
    const outcomes = await enqueueValidatedEvents(
      {
        enqueueEvent: async () => {
          calls++;
          return { msgId: 1 };
        },
      },
      [],
    );

    expect(outcomes).toEqual([]);
    expect(calls).toBe(0);
  });

  it("reports every event as enqueued when all calls succeed", async () => {
    const events = [
      samplePayload({ eventId: "11111111-aaaa-aaaa-aaaa-111111111111" }),
      samplePayload({ eventId: "22222222-aaaa-aaaa-aaaa-222222222222" }),
    ];

    const outcomes = await enqueueValidatedEvents(
      { enqueueEvent: async () => ({ msgId: 1 }) },
      events,
    );

    expect(outcomes).toEqual([
      { eventId: "11111111-aaaa-aaaa-aaaa-111111111111", enqueued: true, error: undefined },
      { eventId: "22222222-aaaa-aaaa-aaaa-222222222222", enqueued: true, error: undefined },
    ]);
  });

  it("reports a per-event failure without throwing when one enqueueEvent call rejects", async () => {
    const failingId = "22222222-aaaa-aaaa-aaaa-222222222222";
    const events = [
      samplePayload({ eventId: "11111111-aaaa-aaaa-aaaa-111111111111" }),
      samplePayload({ eventId: failingId }),
      samplePayload({ eventId: "33333333-aaaa-aaaa-aaaa-333333333333" }),
    ];
    const simulatedError = new Error("simulated queue failure");

    const outcomes = await enqueueValidatedEvents(
      {
        enqueueEvent: async (payload) => {
          if (payload.eventId === failingId) {
            throw simulatedError;
          }
          return { msgId: 1 };
        },
      },
      events,
    );

    expect(outcomes[0]).toEqual({
      eventId: "11111111-aaaa-aaaa-aaaa-111111111111",
      enqueued: true,
      error: undefined,
    });
    expect(outcomes[1]).toEqual({ eventId: failingId, enqueued: false, error: simulatedError });
    expect(outcomes[2]).toEqual({
      eventId: "33333333-aaaa-aaaa-aaaa-333333333333",
      enqueued: true,
      error: undefined,
    });
  });

  // Promise.allSettled isolation: one rejection must not prevent the
  // other (independent, already in-flight) calls from completing and
  // being reported.
  it("isolates failures so one rejected enqueue does not affect other outcomes", async () => {
    const events = [
      samplePayload({ eventId: "11111111-aaaa-aaaa-aaaa-111111111111" }),
      samplePayload({ eventId: "22222222-aaaa-aaaa-aaaa-222222222222" }),
    ];

    const outcomes = await enqueueValidatedEvents(
      {
        enqueueEvent: async (payload) => {
          if (payload.eventId === "11111111-aaaa-aaaa-aaaa-111111111111") {
            throw new Error("first fails");
          }
          return { msgId: 42 };
        },
      },
      events,
    );

    const succeeded = outcomes.filter((o) => o.enqueued);
    const failed = outcomes.filter((o) => !o.enqueued);
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
  });

  it("calls enqueueEvent with the exact ValidatedEventPayload for each event, unmodified", async () => {
    const received: ValidatedEventPayload[] = [];
    const event = samplePayload({ customerId: "cust-1", featureId: "summarizer" });

    await enqueueValidatedEvents(
      {
        enqueueEvent: async (payload) => {
          received.push(payload);
          return { msgId: 1 };
        },
      },
      [event],
    );

    expect(received).toEqual([event]);
  });
});
