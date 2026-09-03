import { describe, it, expect } from "vitest";
import { ingestionEventPayloadSchema } from "@volar/shared";
import { buildLoadTestEvent } from "./generate-event.js";

describe("buildLoadTestEvent", () => {
  it("produces an event that passes the real wire-format schema (issue 6.3)", () => {
    const event = buildLoadTestEvent();
    const result = ingestionEventPayloadSchema.safeParse(event);
    expect(result.success).toBe(true);
  });

  it("uses a provided eventId instead of generating one", () => {
    const event = buildLoadTestEvent({ eventId: "11111111-1111-1111-1111-111111111111" });
    expect(event.event_id).toBe("11111111-1111-1111-1111-111111111111");
  });

  it("generates a unique event_id per call by default", () => {
    const a = buildLoadTestEvent();
    const b = buildLoadTestEvent();
    expect(a.event_id).not.toBe(b.event_id);
  });

  it("uses an injected clock for the timestamp", () => {
    const fixedDate = new Date("2026-09-01T00:00:00.000Z");
    const event = buildLoadTestEvent({ now: () => fixedDate });
    expect(event.timestamp).toBe("2026-09-01T00:00:00.000Z");
  });

  it("picks provider/model/token counts deterministically from an injected random source", () => {
    // random() always returns 0 -> first provider (openai), first model,
    // minimum token counts.
    const event = buildLoadTestEvent({ random: () => 0 });
    expect(event.provider).toBe("openai");
    expect(event.model).toBe("gpt-5.6-luna");
    expect(event.input_tokens).toBe(50);
    expect(event.output_tokens).toBe(20);
  });

  it("always sets status to success and feature_id to load-test", () => {
    const event = buildLoadTestEvent();
    expect(event.status).toBe("success");
    expect(event.feature_id).toBe("load-test");
  });
});
