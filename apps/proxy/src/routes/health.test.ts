import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

// Issue 6.2: buildApp() now requires an events-route deps object (real
// API-key auth needs a real dependency). /health doesn't touch auth at
// all, so an empty stub that would blow up if ever called is enough --
// this test never exercises it.
const testDeps = {
  events: {
    authApiKeyDeps: {
      fetchCandidatesByPrefix: async () => {
        throw new Error("unexpected auth check during a /health test");
      },
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
