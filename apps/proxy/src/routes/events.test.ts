import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { hashApiKey, deriveKeyPrefixFromFullKey } from "@volar/shared";
import { buildApp } from "../app.js";
import type { ApiKeyCandidate, AuthenticateApiKeyDeps } from "../auth/authenticate-api-key.js";

// Issue 6.3: this is the real wire shape (ingestionEventPayloadSchema,
// snake_case per FR-6.5) -- deliberately does NOT include project_id
// (resolved server-side from the authenticated key, see events.ts) or
// the API key itself (travels via the x-api-key header, not the body).
const SAMPLE_PAYLOAD = {
  event_id: "11111111-aaaa-aaaa-aaaa-111111111111",
  provider: "anthropic",
  model: "claude-sonnet-5",
  input_tokens: 100,
  output_tokens: 50,
  timestamp: "2026-08-09T00:00:00.000Z",
  status: "success",
};

const VALID_KEY = "vlr_live_validtestkey00000000000000000000000";

/**
 * In-memory fake for AuthenticateApiKeyDeps, keyed by prefix exactly
 * like the real Supabase adapter's query -- lets these route-level
 * tests exercise the real authenticateApiKey() orchestration (issue
 * 6.2) end-to-end without any DB. The pure grace-period/revocation
 * decision logic itself has its own dedicated fixture tests in
 * ../auth/authenticate-api-key.test.ts; this file only needs enough
 * cases to prove the HTTP layer wires auth in correctly.
 */
function makeAuthDeps(candidates: readonly ApiKeyCandidate[]): AuthenticateApiKeyDeps {
  const byPrefix = new Map<string, ApiKeyCandidate[]>();
  for (const candidate of candidates) {
    // Re-derive each candidate's prefix from a fixture-only convention:
    // tests below always build candidates via candidateFor(), which
    // stashes the originating full key on the object for this purpose.
    const prefix = (candidate as ApiKeyCandidate & { __fullKey: string }).__fullKey;
    const derived = deriveKeyPrefixFromFullKey(prefix);
    if (!derived) continue;
    const bucket = byPrefix.get(derived) ?? [];
    bucket.push(candidate);
    byPrefix.set(derived, bucket);
  }
  return {
    fetchCandidatesByPrefix: async (keyPrefix) => byPrefix.get(keyPrefix) ?? [],
  };
}

function candidateFor(
  fullKey: string,
  overrides: Partial<Omit<ApiKeyCandidate, "hashedKey">> = {},
): ApiKeyCandidate & { __fullKey: string } {
  return {
    id: "key-1",
    projectId: "33333333-3333-3333-3333-333333333333",
    hashedKey: hashApiKey(fullKey),
    revokedAt: null,
    supersededByCreatedAt: null,
    ...overrides,
    __fullKey: fullKey,
  };
}

function buildTestApp(candidates: readonly ApiKeyCandidate[] = [candidateFor(VALID_KEY)]) {
  return buildApp({ events: { authApiKeyDeps: makeAuthDeps(candidates) } });
}

function makeLogCapture(): { stream: Writable; lines: string[] } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  return { stream, lines };
}

function parseLines(lines: string[]): Record<string, unknown>[] {
  return lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

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

describe("POST /v1/events", () => {
  // AC1 (issue 6.1) + AC1 (issue 6.2 -- "Valid current key authenticates
  // successfully"): a well-formed request with a valid key returns 202.
  it("returns 202 with an accepted status when the API key is valid", async () => {
    const app = buildTestApp();

    const response = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { "x-api-key": VALID_KEY },
      payload: SAMPLE_PAYLOAD,
    });

    expect(response.statusCode).toBe(202);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toEqual({ status: "accepted" });
  });

  // Issue 6.2 replaces 6.1's "auth stubbed" behavior -- a request with
  // no API key header must now be rejected.
  it("rejects a request with no x-api-key header at all", async () => {
    const app = buildTestApp();

    const response = await app.inject({
      method: "POST",
      url: "/v1/events",
      payload: SAMPLE_PAYLOAD,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "missing API key" });
  });

  // AC4: "Unknown key rejected without leaking whether the prefix exists"
  it("rejects an unrecognized key with a generic error", async () => {
    const app = buildTestApp();

    const response = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { "x-api-key": "vlr_live_totallyunknownkey0000000000000000" },
      payload: SAMPLE_PAYLOAD,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "invalid API key" });
  });

  it("rejects the right prefix with the wrong secret using the exact same generic error", async () => {
    const app = buildTestApp([candidateFor(VALID_KEY)]);

    const response = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { "x-api-key": "vlr_live_validtestkey99999999999999999999999" },
      payload: SAMPLE_PAYLOAD,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "invalid API key" });
  });

  // AC3: "Revoked key is rejected immediately with a clear error"
  it("rejects a revoked key with a specific message", async () => {
    const app = buildTestApp([
      candidateFor(VALID_KEY, { revokedAt: "2026-08-01T00:00:00.000Z" }),
    ]);

    const response = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { "x-api-key": VALID_KEY },
      payload: SAMPLE_PAYLOAD,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "this API key has been revoked" });
  });

  // AC2: "Key within its rotation grace period still authenticates"
  it("authenticates an old key rotated less than 24h ago", async () => {
    const recentSuccessor = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const app = buildTestApp([
      candidateFor(VALID_KEY, { supersededByCreatedAt: recentSuccessor }),
    ]);

    const response = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { "x-api-key": VALID_KEY },
      payload: SAMPLE_PAYLOAD,
    });

    expect(response.statusCode).toBe(202);
  });

  it("rejects an old key once its grace period has expired", async () => {
    const staleSuccessor = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const app = buildTestApp([
      candidateFor(VALID_KEY, { supersededByCreatedAt: staleSuccessor }),
    ]);

    const response = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { "x-api-key": VALID_KEY },
      payload: SAMPLE_PAYLOAD,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: "this API key's rotation grace period has expired; use your current key",
    });
  });

  // AC2 (issue 6.1): "Endpoint responds within the latency budget...
  // even under a stub implementation". Real auth now sits in the path,
  // but this deps fake is still in-memory (no real network/DB), so the
  // same generous smoke bound still applies -- the real NFR §10.2
  // measurement is issue 7.5's load test.
  it("responds near-instantly even with real auth in the path (smoke check)", async () => {
    const app = buildTestApp();
    const start = performance.now();

    await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { "x-api-key": VALID_KEY },
      payload: SAMPLE_PAYLOAD,
    });

    expect(performance.now() - start).toBeLessThan(200);
  });

  // AC3 (issue 6.1): "Basic request logging in place"
  it("logs a structured line identifying the accepted request", async () => {
    const { stream, lines } = makeLogCapture();
    const app = buildApp(
      { events: { authApiKeyDeps: makeAuthDeps([candidateFor(VALID_KEY)]) } },
      { logger: { level: "info", stream } },
    );

    await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { "x-api-key": VALID_KEY },
      payload: SAMPLE_PAYLOAD,
    });
    await app.close(); // flush pino's stream before reading it back

    const entries = parseLines(lines);
    const ingestionLog = entries.find((entry) => entry.event === "ingestion_request_received");

    expect(ingestionLog).toBeDefined();
    expect(ingestionLog?.method).toBe("POST");
    expect(ingestionLog?.url).toBe("/v1/events");
    expect(ingestionLog?.msg).toBe("POST /v1/events accepted");
    expect(ingestionLog?.projectId).toBe("33333333-3333-3333-3333-333333333333");
    expect(ingestionLog?.eventId).toBe("11111111-aaaa-aaaa-aaaa-111111111111");
  });

  // Issue 6.3, AC1: "Malformed payloads rejected with a 400 and a clear
  // error body". Auth still runs first -- these all use a valid key so
  // the 400 (not a 401) is genuinely what's under test.
  describe("payload validation (issue 6.3)", () => {
    it("rejects a payload with a malformed event_id with 400 and a field-level error", async () => {
      const app = buildTestApp();

      const response = await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { "x-api-key": VALID_KEY },
        payload: { ...SAMPLE_PAYLOAD, event_id: "not-a-uuid" },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.error).toBe("invalid event payload");
      expect(body.fieldErrors.event_id).toBeDefined();
    });

    it("rejects an unsupported provider", async () => {
      const app = buildTestApp();

      const response = await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { "x-api-key": VALID_KEY },
        payload: { ...SAMPLE_PAYLOAD, provider: "cohere" },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().fieldErrors.provider).toBeDefined();
    });

    it("rejects negative token counts", async () => {
      const app = buildTestApp();

      const response = await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { "x-api-key": VALID_KEY },
        payload: { ...SAMPLE_PAYLOAD, input_tokens: -5 },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().fieldErrors.input_tokens).toBeDefined();
    });

    it("rejects a payload missing a required field", async () => {
      const app = buildTestApp();
      const response = await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { "x-api-key": VALID_KEY },
        payload: omit(SAMPLE_PAYLOAD, "status"),
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().fieldErrors.status).toBeDefined();
    });

    it("rejects a payload with no body at all", async () => {
      const app = buildTestApp();
      const response = await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { "x-api-key": VALID_KEY, "content-type": "application/json" },
        payload: "",
      });

      expect(response.statusCode).toBe(400);
    });

    // AC2: "Valid payloads pass through unchanged"
    it("accepts a valid payload with customer_id/feature_id omitted", async () => {
      const app = buildTestApp();
      const response = await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { "x-api-key": VALID_KEY },
        payload: SAMPLE_PAYLOAD,
      });
      expect(response.statusCode).toBe(202);
    });

    it("accepts a valid payload with customer_id/feature_id present, and an unrecognized extra field", async () => {
      const app = buildTestApp();
      const response = await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { "x-api-key": VALID_KEY },
        payload: {
          ...SAMPLE_PAYLOAD,
          customer_id: "cust-1",
          feature_id: "summarizer",
          some_future_sdk_field: "ignored for now",
        },
      });
      expect(response.statusCode).toBe(202);
    });

    // Cross-cutting with issue 6.2: project_id is never accepted from
    // the client body, even if present -- it's always resolved from the
    // authenticated key. This can't be observed directly from the HTTP
    // response yet (no real write until issue 6.5), but a client-supplied
    // project_id must not cause a validation error either (the schema
    // silently strips unknown fields), and must not leak into the log.
    it("ignores a client-supplied project_id in the body entirely", async () => {
      const { stream, lines } = makeLogCapture();
      const app = buildApp(
        { events: { authApiKeyDeps: makeAuthDeps([candidateFor(VALID_KEY)]) } },
        { logger: { level: "info", stream } },
      );

      const response = await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { "x-api-key": VALID_KEY },
        payload: { ...SAMPLE_PAYLOAD, project_id: "99999999-9999-9999-9999-999999999999" },
      });
      await app.close();

      expect(response.statusCode).toBe(202);
      const entries = parseLines(lines);
      const ingestionLog = entries.find((entry) => entry.event === "ingestion_request_received");
      // The authenticated key's project, not the body's spoofed one.
      expect(ingestionLog?.projectId).toBe("33333333-3333-3333-3333-333333333333");
    });
  });
});
