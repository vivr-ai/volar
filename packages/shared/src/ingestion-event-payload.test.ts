import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ingestionEventPayloadSchema } from "./ingestion-event-payload.js";

const VALID_PAYLOAD = {
  event_id: "11111111-aaaa-aaaa-aaaa-111111111111",
  provider: "anthropic",
  model: "claude-sonnet-5",
  input_tokens: 100,
  output_tokens: 50,
  timestamp: "2026-08-09T00:00:00.000Z",
  customer_id: "cust-1",
  feature_id: "summarizer",
  status: "success",
};

/** Returns a shallow copy of `obj` with `key` removed. Used instead of
 * `const { key, ...rest } = obj` to build "missing field" fixtures --
 * that destructuring pattern leaves an unused `key` binding, which this
 * repo's eslint config (no underscore-prefix exemption configured,
 * see packages/config/eslint/base.mjs) flags as an error. */
function omit<T extends object, K extends keyof T>(obj: T, key: K): Omit<T, K> {
  const clone = { ...obj };
  delete clone[key];
  return clone;
}

describe("ingestionEventPayloadSchema", () => {
  // AC2: "Valid payloads pass through unchanged"
  it("accepts a fully-populated valid payload", () => {
    const result = ingestionEventPayloadSchema.safeParse(VALID_PAYLOAD);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.provider).toBe("anthropic");
      expect(result.data.input_tokens).toBe(100);
    }
  });

  it("accepts a payload with customer_id/feature_id omitted entirely", () => {
    const withoutTags = omit(omit(VALID_PAYLOAD, "customer_id"), "feature_id");
    expect(ingestionEventPayloadSchema.safeParse(withoutTags).success).toBe(true);
  });

  it("accepts a payload with customer_id/feature_id explicitly null", () => {
    const result = ingestionEventPayloadSchema.safeParse({
      ...VALID_PAYLOAD,
      customer_id: null,
      feature_id: null,
    });
    expect(result.success).toBe(true);
  });

  it("accepts both provider values", () => {
    expect(ingestionEventPayloadSchema.safeParse({ ...VALID_PAYLOAD, provider: "openai" }).success).toBe(true);
    expect(ingestionEventPayloadSchema.safeParse({ ...VALID_PAYLOAD, provider: "anthropic" }).success).toBe(true);
  });

  it("accepts both status values", () => {
    expect(ingestionEventPayloadSchema.safeParse({ ...VALID_PAYLOAD, status: "success" }).success).toBe(true);
    expect(ingestionEventPayloadSchema.safeParse({ ...VALID_PAYLOAD, status: "error" }).success).toBe(true);
  });

  it("accepts a timestamp with a numeric UTC offset instead of Z", () => {
    const result = ingestionEventPayloadSchema.safeParse({
      ...VALID_PAYLOAD,
      timestamp: "2026-08-09T05:30:00+05:30",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a non-RFC-version UUID for event_id, matching Postgres's own uuid column laxness", () => {
    // Not a real RFC 4122 version/variant -- but Postgres's uuid column
    // accepts it (and this exact style is used by other test fixtures
    // throughout this codebase), so the schema must too.
    const result = ingestionEventPayloadSchema.safeParse({
      ...VALID_PAYLOAD,
      event_id: "99999999-9999-9999-9999-999999999999",
    });
    expect(result.success).toBe(true);
  });

  it("strips unknown extra fields rather than rejecting the payload", () => {
    const result = ingestionEventPayloadSchema.safeParse({
      ...VALID_PAYLOAD,
      some_future_field: "not part of the contract yet",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("some_future_field");
    }
  });

  // AC1: "Malformed payloads rejected with a 400 and a clear error body"
  // (the 400 itself is verified at the HTTP layer in events.test.ts --
  // these assert the schema itself actually rejects each bad case).
  it("rejects a non-UUID event_id", () => {
    const result = ingestionEventPayloadSchema.safeParse({ ...VALID_PAYLOAD, event_id: "not-a-uuid" });
    expect(result.success).toBe(false);
  });

  it("rejects an unsupported provider", () => {
    const result = ingestionEventPayloadSchema.safeParse({ ...VALID_PAYLOAD, provider: "cohere" });
    expect(result.success).toBe(false);
  });

  it("rejects an empty model string", () => {
    expect(ingestionEventPayloadSchema.safeParse({ ...VALID_PAYLOAD, model: "" }).success).toBe(false);
  });

  it("rejects negative token counts", () => {
    expect(ingestionEventPayloadSchema.safeParse({ ...VALID_PAYLOAD, input_tokens: -1 }).success).toBe(false);
    expect(ingestionEventPayloadSchema.safeParse({ ...VALID_PAYLOAD, output_tokens: -1 }).success).toBe(false);
  });

  it("rejects non-integer token counts", () => {
    expect(ingestionEventPayloadSchema.safeParse({ ...VALID_PAYLOAD, input_tokens: 1.5 }).success).toBe(false);
  });

  it("rejects a malformed timestamp", () => {
    expect(ingestionEventPayloadSchema.safeParse({ ...VALID_PAYLOAD, timestamp: "not-a-date" }).success).toBe(false);
  });

  it("rejects an invalid status value", () => {
    expect(ingestionEventPayloadSchema.safeParse({ ...VALID_PAYLOAD, status: "pending" }).success).toBe(false);
  });

  it("rejects a payload missing a required field", () => {
    expect(ingestionEventPayloadSchema.safeParse(omit(VALID_PAYLOAD, "event_id")).success).toBe(false);
  });

  it("rejects a completely empty object, listing every missing required field", () => {
    const result = ingestionEventPayloadSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      const flattened = z.flattenError(result.error);
      for (const field of ["event_id", "provider", "model", "input_tokens", "output_tokens", "timestamp", "status"]) {
        expect(flattened.fieldErrors).toHaveProperty(field);
      }
    }
  });
});
