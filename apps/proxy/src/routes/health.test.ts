import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createInMemoryRateLimitStore, DEFAULT_INGESTION_RATE_LIMIT_CONFIG } from "../rate-limit/rate-limiter.js";

// Issue 6.2: buildApp() now requires an events-route deps object (real
// API-key auth needs a real dependency). /health doesn't touch auth at
// all, so an empty stub that would blow up if ever called is enough --
// this test never exercises it.
// Issue 6.5: same reasoning for rateLimit -- /health never reaches the
// events route's preHandlers, so a real (harmless, unused) store is
// enough; no need for a throwing stub since nothing about rate-limit
// deps can be "called unexpectedly" the way an auth DB lookup can.
// Issue 6.6: touchLastUsedAt gets the same throwing-stub treatment as
// authApiKeyDeps -- /health should never reach it either.
const testDeps = {
  events: {
    authApiKeyDeps: {
      fetchCandidatesByPrefix: async () => {
        throw new Error("unexpected auth check during a /health test");
      },
    },
    touchLastUsedAt: async () => {
      throw new Error("unexpected last_used_at touch during a /health test");
    },
    rateLimit: {
      store: createInMemoryRateLimitStore(),
      config: DEFAULT_INGESTION_RATE_LIMIT_CONFIG,
    },
  },
};

describe("GET /health", () => {
  it("returns 200 with a JSON status payload", async () => {
    const app = buildApp(testDeps);

    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");

    const body = response.json();
    expect(body.status).toBe("ok");
    expect(body.service).toBe("volar-proxy");
    expect(typeof body.uptime_seconds).toBe("number");
    expect(typeof body.timestamp).toBe("string");
  });
});
