import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { hashApiKey, deriveKeyPrefixFromFullKey } from "@volar/shared";
import { buildApp } from "../app.js";
import type { ApiKeyCandidate, AuthenticateApiKeyDeps } from "../auth/authenticate-api-key.js";
import {
  createInMemoryRateLimitStore,
  DEFAULT_INGESTION_RATE_LIMIT_CONFIG,
  type RateLimitConfig,
} from "../rate-limit/rate-limiter.js";
import type { EventsRouteDeps } from "./events.js";
import type { ValidatedEventPayload } from "../ingestion/write-llm-call-event.js";

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

/**
 * Fresh in-memory rate-limit deps, defaulting to the real production
 * threshold (DEFAULT_INGESTION_RATE_LIMIT_CONFIG) so ordinary tests --
 * which fire at most a handful of requests each -- implicitly prove
 * normal traffic never trips it, using the actual shipped number
 * rather than a redefined test-only copy. A fresh store per call means
 * no cross-test pollution even though buildTestApp() is called many
 * times across this file.
 */
function defaultRateLimitDeps(config: RateLimitConfig = DEFAULT_INGESTION_RATE_LIMIT_CONFIG): EventsRouteDeps["rateLimit"] {
  return { store: createInMemoryRateLimitStore(), config };
}

/**
 * Records every apiKeyId touchLastUsedAt was called with, resolving
 * immediately by default. Tests that only care about the *shape* of
 * the request (most of this file) don't need to construct one --
 * buildTestApp() defaults to a plain no-op recorder-less stub; tests
 * in the "last_used_at update (issue 6.6)" describe block build their
 * own so they can assert on `calls`.
 */
function makeTouchLastUsedAtRecorder(
  impl: (apiKeyId: string) => Promise<void> = async () => {},
): { touchLastUsedAt: EventsRouteDeps["touchLastUsedAt"]; calls: string[] } {
  const calls: string[] = [];
  return {
    touchLastUsedAt: async (apiKeyId: string) => {
      calls.push(apiKeyId);
      return impl(apiKeyId);
    },
    calls,
  };
}

/**
 * Records every payload enqueueEvent was called with, resolving with an
 * incrementing msgId by default. Same shape as makeTouchLastUsedAtRecorder
 * above -- tests that only care about the ordinary success path don't
 * need to construct one (buildTestApp() defaults to an always-succeeding
 * stub); tests in the "enqueueing onto the ingestion queue (issue 7.2)"
 * describe block build their own so they can assert on `calls`, force a
 * rejection, or hold the returned promise open to prove the handler
 * genuinely awaits it.
 */
function makeEnqueueEventRecorder(
  impl: (payload: ValidatedEventPayload) => Promise<{ msgId: number }> = async () => ({
    msgId: recorderMsgIdCounter++,
  }),
): { enqueueEvent: EventsRouteDeps["enqueueEvent"]; calls: ValidatedEventPayload[] } {
  const calls: ValidatedEventPayload[] = [];
  return {
    enqueueEvent: async (payload: ValidatedEventPayload) => {
      calls.push(payload);
      return impl(payload);
    },
    calls,
  };
}
let recorderMsgIdCounter = 1;

function buildTestApp(
  candidates: readonly ApiKeyCandidate[] = [candidateFor(VALID_KEY)],
  rateLimit: EventsRouteDeps["rateLimit"] = defaultRateLimitDeps(),
  touchLastUsedAt: EventsRouteDeps["touchLastUsedAt"] = async () => {},
  enqueueEvent: EventsRouteDeps["enqueueEvent"] = async () => ({ msgId: 1 }),
) {
  return buildApp({
    events: { authApiKeyDeps: makeAuthDeps(candidates), rateLimit, touchLastUsedAt, enqueueEvent },
  });
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
      {
        events: {
          authApiKeyDeps: makeAuthDeps([candidateFor(VALID_KEY)]),
          rateLimit: defaultRateLimitDeps(),
          touchLastUsedAt: async () => {},
          enqueueEvent: async () => ({ msgId: 1 }),
        },
      },
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
    // Issue 6.4: the summary log line reports counts (works uniformly
    // for both a single request and a batch), not a single eventId.
    expect(ingestionLog?.batch).toBe(false);
    expect(ingestionLog?.accepted).toBe(1);
    expect(ingestionLog?.rejected).toBe(0);
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
        {
          events: {
            authApiKeyDeps: makeAuthDeps([candidateFor(VALID_KEY)]),
            rateLimit: defaultRateLimitDeps(),
            touchLastUsedAt: async () => {},
            enqueueEvent: async () => ({ msgId: 1 }),
          },
        },
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

  // Issue 6.4: batch support (FR-6.8's local-batching behavior).
  describe("batch support (issue 6.4)", () => {
    function eventPayload(eventId: string, overrides: Record<string, unknown> = {}) {
      return { ...SAMPLE_PAYLOAD, event_id: eventId, ...overrides };
    }

    // AC1: "A batch of N events results in N rows ... not N separate
    // HTTP round trips required from the SDK" -- the real DB write is a
    // later issue (6.5/7.x), so what's verifiable here is the plumbing:
    // one HTTP call carries N independently-tracked outcomes.
    it("accepts a batch of 3 valid events as a single request, reporting all 3", async () => {
      const app = buildTestApp();
      const response = await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { "x-api-key": VALID_KEY },
        payload: [
          eventPayload("11111111-aaaa-aaaa-aaaa-111111111111"),
          eventPayload("22222222-aaaa-aaaa-aaaa-222222222222"),
          eventPayload("33333333-aaaa-aaaa-aaaa-333333333333"),
        ],
      });

      expect(response.statusCode).toBe(202);
      const body = response.json();
      expect(body.accepted).toBe(3);
      expect(body.rejected).toBe(0);
      expect(body.results).toEqual([
        { index: 0, status: "accepted", eventId: "11111111-aaaa-aaaa-aaaa-111111111111" },
        { index: 1, status: "accepted", eventId: "22222222-aaaa-aaaa-aaaa-222222222222" },
        { index: 2, status: "accepted", eventId: "33333333-aaaa-aaaa-aaaa-333333333333" },
      ]);
    });

    // AC2: "Partial-batch failure (one bad event in an otherwise valid
    // batch) does not fail the whole batch — bad events are rejected
    // individually and reported back."
    it("accepts the whole batch (202) even when one of several events is malformed, reporting each outcome individually", async () => {
      const app = buildTestApp();
      const response = await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { "x-api-key": VALID_KEY },
        payload: [
          eventPayload("11111111-aaaa-aaaa-aaaa-111111111111"),
          eventPayload("22222222-aaaa-aaaa-aaaa-222222222222", { input_tokens: -5 }),
          eventPayload("33333333-aaaa-aaaa-aaaa-333333333333"),
        ],
      });

      // The whole-request status is still 202 -- one bad event never
      // fails the batch (AC2), unlike the single-event path (6.3).
      expect(response.statusCode).toBe(202);
      const body = response.json();
      expect(body.accepted).toBe(2);
      expect(body.rejected).toBe(1);
      expect(body.results[0]).toEqual({ index: 0, status: "accepted", eventId: "11111111-aaaa-aaaa-aaaa-111111111111" });
      expect(body.results[1].status).toBe("rejected");
      expect(body.results[1].index).toBe(1);
      expect(body.results[1].fieldErrors.input_tokens).toBeDefined();
      expect(body.results[2]).toEqual({ index: 2, status: "accepted", eventId: "33333333-aaaa-aaaa-aaaa-333333333333" });
    });

    it("still returns 202 with all-rejected results when every event in a batch is malformed", async () => {
      const app = buildTestApp();
      const response = await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { "x-api-key": VALID_KEY },
        payload: [
          eventPayload("11111111-aaaa-aaaa-aaaa-111111111111", { provider: "cohere" }),
          eventPayload("22222222-aaaa-aaaa-aaaa-222222222222", { input_tokens: -1 }),
        ],
      });

      expect(response.statusCode).toBe(202);
      const body = response.json();
      expect(body.accepted).toBe(0);
      expect(body.rejected).toBe(2);
    });

    it("accepts a single-element array (a batch of one)", async () => {
      const app = buildTestApp();
      const response = await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { "x-api-key": VALID_KEY },
        payload: [eventPayload("11111111-aaaa-aaaa-aaaa-111111111111")],
      });

      expect(response.statusCode).toBe(202);
      const body = response.json();
      expect(body.accepted).toBe(1);
      expect(body.results).toHaveLength(1);
    });

    // Judgment call documented in events.ts: an empty batch has nothing
    // to process, so it's a top-level 400 rather than a vacuous
    // "0 accepted, 0 rejected" 202.
    it("rejects an empty batch array with 400", async () => {
      const app = buildTestApp();
      const response = await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { "x-api-key": VALID_KEY },
        payload: [],
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "batch must contain at least one event" });
    });

    it("still requires the same authenticated key for a batch request (auth applies once, to the whole request)", async () => {
      const app = buildTestApp();
      const response = await app.inject({
        method: "POST",
        url: "/v1/events",
        payload: [eventPayload("11111111-aaaa-aaaa-aaaa-111111111111")],
      });

      expect(response.statusCode).toBe(401);
    });

    it("logs a summary line with correct accepted/rejected counts for a batch", async () => {
      const { stream, lines } = makeLogCapture();
      const app = buildApp(
        {
          events: {
            authApiKeyDeps: makeAuthDeps([candidateFor(VALID_KEY)]),
            rateLimit: defaultRateLimitDeps(),
            touchLastUsedAt: async () => {},
            enqueueEvent: async () => ({ msgId: 1 }),
          },
        },
        { logger: { level: "info", stream } },
      );

      await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { "x-api-key": VALID_KEY },
        payload: [
          eventPayload("11111111-aaaa-aaaa-aaaa-111111111111"),
          eventPayload("22222222-aaaa-aaaa-aaaa-222222222222", { model: "" }),
        ],
      });
      await app.close();

      const entries = parseLines(lines);
      const ingestionLog = entries.find((entry) => entry.event === "ingestion_request_received");
      const rejectedLog = entries.find((entry) => entry.event === "payload_rejected");

      expect(ingestionLog?.batch).toBe(true);
      expect(ingestionLog?.accepted).toBe(1);
      expect(ingestionLog?.rejected).toBe(1);
      expect(rejectedLog).toBeDefined();
      expect(rejectedLog?.rejectedCount).toBe(1);
    });
  });

  // Issue 6.5: per-API-key rate limiting. Most tests below use a
  // deliberately tiny limit (2/min) rather than the real 300/min
  // default -- firing 300+ sequential .inject() calls per test would
  // work but is needlessly slow; a tiny, explicit limit exercises the
  // exact same checkRateLimit() code path (already unit-tested against
  // the real default's numbers in rate-limiter.test.ts) deterministically
  // and fast. The real default is still exercised implicitly by every
  // *other* test in this file, none of which come close to tripping it.
  describe("rate limiting (issue 6.5)", () => {
    const TINY_LIMIT: RateLimitConfig = { limit: 2, windowMs: 60_000 };

    // AC1: "Requests beyond the configured threshold receive a 429
    // with a Retry-After header."
    it("returns 429 with a Retry-After header once a key exceeds its limit", async () => {
      const app = buildTestApp([candidateFor(VALID_KEY)], defaultRateLimitDeps(TINY_LIMIT));

      for (let i = 0; i < TINY_LIMIT.limit; i++) {
        const ok = await app.inject({
          method: "POST",
          url: "/v1/events",
          headers: { "x-api-key": VALID_KEY },
          payload: SAMPLE_PAYLOAD,
        });
        expect(ok.statusCode).toBe(202);
      }

      const blocked = await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { "x-api-key": VALID_KEY },
        payload: SAMPLE_PAYLOAD,
      });

      expect(blocked.statusCode).toBe(429);
      expect(blocked.headers["retry-after"]).toBeDefined();
      expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
      expect(blocked.json().error).toBe("rate limit exceeded, please slow down");
    });

    // AC2: "Rate limit is per API key, not global."
    it("tracks separate budgets per API key, not a shared/global one", async () => {
      const OTHER_KEY = "vlr_live_othertestkey000000000000000000000000";
      const app = buildTestApp(
        [
          candidateFor(VALID_KEY, { id: "key-1" }),
          candidateFor(OTHER_KEY, { id: "key-2" }),
        ],
        defaultRateLimitDeps(TINY_LIMIT),
      );

      // Exhaust VALID_KEY's budget.
      for (let i = 0; i < TINY_LIMIT.limit; i++) {
        await app.inject({
          method: "POST",
          url: "/v1/events",
          headers: { "x-api-key": VALID_KEY },
          payload: SAMPLE_PAYLOAD,
        });
      }
      const validKeyBlocked = await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { "x-api-key": VALID_KEY },
        payload: SAMPLE_PAYLOAD,
      });
      expect(validKeyBlocked.statusCode).toBe(429);

      // OTHER_KEY has never been charged -- still has its full budget,
      // proving the limit isn't a single global counter.
      const otherKeyStillOk = await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { "x-api-key": OTHER_KEY },
        payload: SAMPLE_PAYLOAD,
      });
      expect(otherKeyStillOk.statusCode).toBe(202);
    });

    // Auth must still run first: an unauthenticated request should
    // never consume (or be evaluated against) any key's rate-limit
    // budget -- see makeRateLimitPreHandler's comment in events.ts.
    it("does not consume rate-limit budget for a request that fails auth", async () => {
      const app = buildTestApp([candidateFor(VALID_KEY)], defaultRateLimitDeps(TINY_LIMIT));

      // Fire more than the tiny limit's worth of *unauthenticated*
      // requests -- if these were (wrongly) charged against some
      // shared bucket, a subsequent authenticated request could be
      // incorrectly blocked.
      for (let i = 0; i < TINY_LIMIT.limit + 3; i++) {
        const response = await app.inject({
          method: "POST",
          url: "/v1/events",
          payload: SAMPLE_PAYLOAD,
        });
        expect(response.statusCode).toBe(401);
      }

      const authenticated = await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { "x-api-key": VALID_KEY },
        payload: SAMPLE_PAYLOAD,
      });
      expect(authenticated.statusCode).toBe(202);
    });

    // AC3 (documented threshold): a smoke check that the real,
    // shipped default (300/min) does not interfere with ordinary
    // traffic -- a handful of requests, well under the threshold, all
    // succeed.
    it("does not interfere with ordinary traffic under the real default threshold", async () => {
      const app = buildTestApp(); // real DEFAULT_INGESTION_RATE_LIMIT_CONFIG

      for (let i = 0; i < 5; i++) {
        const response = await app.inject({
          method: "POST",
          url: "/v1/events",
          headers: { "x-api-key": VALID_KEY },
          payload: SAMPLE_PAYLOAD,
        });
        expect(response.statusCode).toBe(202);
      }
    });

    it("logs a structured warning when a request is rate-limited", async () => {
      const { stream, lines } = makeLogCapture();
      const app = buildApp(
        {
          events: {
            authApiKeyDeps: makeAuthDeps([candidateFor(VALID_KEY)]),
            rateLimit: defaultRateLimitDeps(TINY_LIMIT),
            touchLastUsedAt: async () => {},
            enqueueEvent: async () => ({ msgId: 1 }),
          },
        },
        { logger: { level: "info", stream } },
      );

      for (let i = 0; i < TINY_LIMIT.limit; i++) {
        await app.inject({
          method: "POST",
          url: "/v1/events",
          headers: { "x-api-key": VALID_KEY },
          payload: SAMPLE_PAYLOAD,
        });
      }
      await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { "x-api-key": VALID_KEY },
        payload: SAMPLE_PAYLOAD,
      });
      await app.close();

      const entries = parseLines(lines);
      const rateLimitLog = entries.find((entry) => entry.event === "rate_limit_exceeded");
      expect(rateLimitLog).toBeDefined();
      expect(rateLimitLog?.apiKeyId).toBe("key-1");
    });
  });

  // Issue 6.6: fire-and-forget api_keys.last_used_at update on
  // successful auth. The real DB write itself is verified live against
  // Supabase (see docs/RLS.md) -- these tests only cover the HTTP
  // layer's responsibility: calling touchLastUsedAt with the right
  // apiKeyId exactly when auth succeeds, and never letting it affect
  // the response either way (AC1: no added latency; AC2: never fails
  // the request).
  describe("last_used_at update (issue 6.6)", () => {
    it("calls touchLastUsedAt with the authenticated key's id on successful auth", async () => {
      const recorder = makeTouchLastUsedAtRecorder();
      const app = buildTestApp([candidateFor(VALID_KEY, { id: "key-1" })], undefined, recorder.touchLastUsedAt);

      const response = await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { "x-api-key": VALID_KEY },
        payload: SAMPLE_PAYLOAD,
      });

      expect(response.statusCode).toBe(202);
      expect(recorder.calls).toEqual(["key-1"]);
    });

    it("does not call touchLastUsedAt when auth fails", async () => {
      const recorder = makeTouchLastUsedAtRecorder();
      const app = buildTestApp([candidateFor(VALID_KEY)], undefined, recorder.touchLastUsedAt);

      const response = await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { "x-api-key": "vlr_live_totallyunknownkey0000000000000000" },
        payload: SAMPLE_PAYLOAD,
      });

      expect(response.statusCode).toBe(401);
      expect(recorder.calls).toEqual([]);
    });

    // AC1: "without adding meaningful latency to the request path" --
    // proven directly, not just asserted: touchLastUsedAt here never
    // resolves at all, and the request still completes almost
    // instantly. If the implementation ever accidentally awaited this
    // call, this test would hang and fail on Vitest's default timeout
    // rather than silently pass.
    it("does not wait for touchLastUsedAt to resolve before responding", async () => {
      const neverResolves = () => new Promise<void>(() => {});
      const app = buildTestApp([candidateFor(VALID_KEY)], undefined, neverResolves);

      const start = performance.now();
      const response = await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { "x-api-key": VALID_KEY },
        payload: SAMPLE_PAYLOAD,
      });

      expect(response.statusCode).toBe(202);
      expect(performance.now() - start).toBeLessThan(200);
    });

    // AC2: "a failure to update last_used_at never fails the ingestion
    // request" -- a rejected touchLastUsedAt must not turn a would-be
    // 202 into an error response.
    it("still returns 202 even when touchLastUsedAt rejects", async () => {
      const alwaysRejects = async () => {
        throw new Error("simulated DB failure");
      };
      const app = buildTestApp([candidateFor(VALID_KEY)], undefined, alwaysRejects);

      const response = await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { "x-api-key": VALID_KEY },
        payload: SAMPLE_PAYLOAD,
      });

      expect(response.statusCode).toBe(202);
    });

    it("logs a structured warning (without failing the request) when touchLastUsedAt rejects", async () => {
      const { stream, lines } = makeLogCapture();
      const alwaysRejects = async () => {
        throw new Error("simulated DB failure");
      };
      const app = buildApp(
        {
          events: {
            authApiKeyDeps: makeAuthDeps([candidateFor(VALID_KEY, { id: "key-1" })]),
            rateLimit: defaultRateLimitDeps(),
            touchLastUsedAt: alwaysRejects,
            enqueueEvent: async () => ({ msgId: 1 }),
          },
        },
        { logger: { level: "info", stream } },
      );

      const response = await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { "x-api-key": VALID_KEY },
        payload: SAMPLE_PAYLOAD,
      });
      // The rejection is async (fires after the response is already
      // being sent) -- give the swallowed .catch() a tick to run before
      // asserting on the captured log and closing the app.
      await new Promise((resolve) => setImmediate(resolve));
      await app.close();

      expect(response.statusCode).toBe(202);
      const entries = parseLines(lines);
      const failureLog = entries.find((entry) => entry.event === "last_used_at_update_failed");
      expect(failureLog).toBeDefined();
      expect(failureLog?.apiKeyId).toBe("key-1");
    });
  });

  // Issue 7.2: every validated event is durably enqueued before the
  // response is sent, instead of written directly to Postgres. Unlike
  // 6.6's touchLastUsedAt, a failed enqueue genuinely fails the request
  // (503, whole-batch) -- see events.ts's header comment for the
  // reasoning. The real Supabase RPC round-trip itself is covered
  // separately (supabase-queue-repository's own live test / docs/RLS.md);
  // these tests only cover the HTTP layer's responsibility: calling
  // enqueueEvent for every validated event, genuinely awaiting it, and
  // turning any failure into a 503 rather than a partial 202.
  describe("enqueueing onto the ingestion queue (issue 7.2)", () => {
    it("enqueues the single validated event on the ordinary success path", async () => {
      const recorder = makeEnqueueEventRecorder();
      const app = buildTestApp(undefined, undefined, undefined, recorder.enqueueEvent);

      const response = await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { "x-api-key": VALID_KEY },
        payload: SAMPLE_PAYLOAD,
      });

      expect(response.statusCode).toBe(202);
      expect(recorder.calls).toHaveLength(1);
      expect(recorder.calls[0].eventId).toBe(SAMPLE_PAYLOAD.event_id);
      // project_id is resolved from the authenticated key, not the body
      // -- same guarantee as the direct-write path this replaces.
      expect(recorder.calls[0].projectId).toBe("33333333-3333-3333-3333-333333333333");
    });

    it("calls enqueueEvent once per validated event in a batch (N events -> N calls)", async () => {
      const recorder = makeEnqueueEventRecorder();
      const app = buildTestApp(undefined, undefined, undefined, recorder.enqueueEvent);

      const response = await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { "x-api-key": VALID_KEY },
        payload: [
          { ...SAMPLE_PAYLOAD, event_id: "11111111-aaaa-aaaa-aaaa-111111111111" },
          { ...SAMPLE_PAYLOAD, event_id: "22222222-aaaa-aaaa-aaaa-222222222222" },
          { ...SAMPLE_PAYLOAD, event_id: "33333333-aaaa-aaaa-aaaa-333333333333" },
        ],
      });

      expect(response.statusCode).toBe(202);
      expect(recorder.calls.map((c) => c.eventId)).toEqual([
        "11111111-aaaa-aaaa-aaaa-111111111111",
        "22222222-aaaa-aaaa-aaaa-222222222222",
        "33333333-aaaa-aaaa-aaaa-333333333333",
      ]);
    });

    it("never calls enqueueEvent when every event in a batch fails validation", async () => {
      const recorder = makeEnqueueEventRecorder();
      const app = buildTestApp(undefined, undefined, undefined, recorder.enqueueEvent);

      const response = await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { "x-api-key": VALID_KEY },
        payload: [
          { ...SAMPLE_PAYLOAD, event_id: "11111111-aaaa-aaaa-aaaa-111111111111", provider: "cohere" },
        ],
      });

      // Validation failure still reports 202-with-rejected-results (6.4's
      // existing behavior, unchanged) -- there's simply nothing to
      // enqueue.
      expect(response.statusCode).toBe(202);
      expect(response.json().rejected).toBe(1);
      expect(recorder.calls).toEqual([]);
    });

    it("never calls enqueueEvent for a single (non-batch) request that fails validation", async () => {
      const recorder = makeEnqueueEventRecorder();
      const app = buildTestApp(undefined, undefined, undefined, recorder.enqueueEvent);

      const response = await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { "x-api-key": VALID_KEY },
        payload: { ...SAMPLE_PAYLOAD, input_tokens: -5 },
      });

      expect(response.statusCode).toBe(400);
      expect(recorder.calls).toEqual([]);
    });

    it("genuinely awaits enqueueEvent before responding, not fire-and-forget", async () => {
      let resolveEnqueue!: (value: { msgId: number }) => void;
      const pending = new Promise<{ msgId: number }>((resolve) => {
        resolveEnqueue = resolve;
      });
      const app = buildTestApp(undefined, undefined, undefined, async () => pending);

      const responsePromise = app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { "x-api-key": VALID_KEY },
        payload: SAMPLE_PAYLOAD,
      });

      // Give the event loop a chance to run as far as it can without the
      // enqueue promise resolving -- if the handler were (wrongly) not
      // awaiting enqueueEvent, the response would already be settled by
      // now.
      let settledEarly = false;
      responsePromise.then(() => {
        settledEarly = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(settledEarly).toBe(false);

      resolveEnqueue({ msgId: 1 });
      const response = await responsePromise;
      expect(response.statusCode).toBe(202);
    });

    // AC (issue 7.2): a failed enqueue must fail the request -- unlike
    // 6.6's best-effort touchLastUsedAt, this is the delivery guarantee
    // the endpoint promises the caller.
    it("returns 503 when the single event's enqueue fails", async () => {
      const alwaysFails = async () => {
        throw new Error("simulated queue failure");
      };
      const app = buildTestApp(undefined, undefined, undefined, alwaysFails);

      const response = await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { "x-api-key": VALID_KEY },
        payload: SAMPLE_PAYLOAD,
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        error: "failed to durably enqueue one or more events, please retry",
        enqueueFailures: 1,
      });
    });

    // Whole-batch 503 on partial enqueue failure, not a partial 202 --
    // see events.ts's header comment for the judgment call and why this
    // is safe to retry (event_id idempotency, issue 5.4).
    it("returns a whole-batch 503 when only one of several events fails to enqueue", async () => {
      const failingEventId = "22222222-aaaa-aaaa-aaaa-222222222222";
      const partiallyFails = async (payload: ValidatedEventPayload) => {
        if (payload.eventId === failingEventId) {
          throw new Error("simulated queue failure");
        }
        return { msgId: 1 };
      };
      const app = buildTestApp(undefined, undefined, undefined, partiallyFails);

      const response = await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { "x-api-key": VALID_KEY },
        payload: [
          { ...SAMPLE_PAYLOAD, event_id: "11111111-aaaa-aaaa-aaaa-111111111111" },
          { ...SAMPLE_PAYLOAD, event_id: failingEventId },
          { ...SAMPLE_PAYLOAD, event_id: "33333333-aaaa-aaaa-aaaa-333333333333" },
        ],
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        error: "failed to durably enqueue one or more events, please retry",
        enqueueFailures: 1,
      });
    });

    it("logs a structured error listing the failed event ids when enqueue fails", async () => {
      const { stream, lines } = makeLogCapture();
      const alwaysFails = async () => {
        throw new Error("simulated queue failure");
      };
      const app = buildApp(
        {
          events: {
            authApiKeyDeps: makeAuthDeps([candidateFor(VALID_KEY)]),
            rateLimit: defaultRateLimitDeps(),
            touchLastUsedAt: async () => {},
            enqueueEvent: alwaysFails,
          },
        },
        { logger: { level: "info", stream } },
      );

      const response = await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { "x-api-key": VALID_KEY },
        payload: SAMPLE_PAYLOAD,
      });
      await app.close();

      expect(response.statusCode).toBe(503);
      const entries = parseLines(lines);
      const failureLog = entries.find((entry) => entry.event === "enqueue_failed");
      expect(failureLog).toBeDefined();
      expect(failureLog?.enqueueFailureCount).toBe(1);
      expect(failureLog?.failedEventIds).toEqual([SAMPLE_PAYLOAD.event_id]);
    });
  });
});
