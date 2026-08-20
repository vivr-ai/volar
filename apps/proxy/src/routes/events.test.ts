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

function buildTestApp(
  candidates: readonly ApiKeyCandidate[] = [candidateFor(VALID_KEY)],
  rateLimit: EventsRouteDeps["rateLimit"] = defaultRateLimitDeps(),
) {
  return buildApp({ events: { authApiKeyDeps: makeAuthDeps(candidates), rateLimit } });
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
      { events: { authApiKeyDeps: makeAuthDeps([candidateFor(VALID_KEY)]), rateLimit: defaultRateLimitDeps() } },
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
        { events: { authApiKeyDeps: makeAuthDeps([candidateFor(VALID_KEY)]), rateLimit: defaultRateLimitDeps() } },
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
        { events: { authApiKeyDeps: makeAuthDeps([candidateFor(VALID_KEY)]), rateLimit: defaultRateLimitDeps() } },
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
});
