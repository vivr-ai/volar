import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

describe("GET /health", () => {
  it("returns 200 with a JSON status payload", async () => {
    const app = buildApp();

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
