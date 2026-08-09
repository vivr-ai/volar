import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

const SAMPLE_PAYLOAD = {
  eventId: "11111111-aaaa-aaaa-aaaa-111111111111",
  projectId: "33333333-3333-3333-3333-333333333333",
  provider: "anthropic",
  model: "claude-sonnet-5",
  inputTokens: 100,
  outputTokens: 50,
  occurredAt: "2026-08-09T00:00:00.000Z",
  status: "success",
};

/**
 * Captures every line Fastify's pino logger writes, so tests can assert
 * on the *actual* structured log output (AC3) rather than guessing at
 * pino's internal child-logger method binding. Each captured line is a
 * JSON string; parseLines() below turns them back into objects.
 */
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

describe("POST /v1/events", () => {
  // AC1: "Endpoint exists at POST /v1/events and returns 202 on a
  // well-formed request (stubbed auth for now)".
  it("returns 202 with an accepted status on a well-formed request", async () => {
    const app = buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/v1/events",
      payload: SAMPLE_PAYLOAD,
    });

    expect(response.statusCode).toBe(202);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toEqual({ status: "accepted" });
  });

  // AC1's "(stubbed auth for now)": real auth is issue 6.2. Until then, a
  // request with no API key header at all must still succeed -- if this
  // test starts failing once 6.2 lands, that's expected and correct
  // (6.2 will replace it with positive/negative auth-case tests).
  it("does not enforce any auth yet -- a request with no API key header still succeeds", async () => {
    const app = buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/v1/events",
      payload: SAMPLE_PAYLOAD,
      headers: {},
    });

    expect(response.statusCode).toBe(202);
  });

  // AC2: "Endpoint responds within the latency budget (PRD NFR §10.2)
  // even under a stub implementation". NFR §10.2's real budget (50ms p95
  // / 150ms p99) is measured against a customer's live LLM call over a
  // real network in issue 7.5's load test -- that's the actual
  // verification of this NFR. This is a much looser in-process smoke
  // check: with no auth/validation/DB/queue work in the path yet, the
  // stub handler should be near-instant, so a generous bound here just
  // catches an accidental blocking call creeping into the scaffold
  // without being flaky in CI.
  it("responds near-instantly as a stub (smoke check against the NFR §10.2 budget)", async () => {
    const app = buildApp();
    const start = performance.now();

    await app.inject({
      method: "POST",
      url: "/v1/events",
      payload: SAMPLE_PAYLOAD,
    });

    const elapsedMs = performance.now() - start;
    expect(elapsedMs).toBeLessThan(200);
  });

  // AC3: "Basic request logging in place".
  it("logs a structured line identifying the accepted request", async () => {
    const { stream, lines } = makeLogCapture();
    const app = buildApp({ logger: { level: "info", stream } });

    await app.inject({
      method: "POST",
      url: "/v1/events",
      payload: SAMPLE_PAYLOAD,
    });
    await app.close(); // flush pino's stream before reading it back

    const entries = parseLines(lines);
    const ingestionLog = entries.find((entry) => entry.event === "ingestion_request_received");

    expect(ingestionLog).toBeDefined();
    expect(ingestionLog?.method).toBe("POST");
    expect(ingestionLog?.url).toBe("/v1/events");
    expect(ingestionLog?.msg).toBe("POST /v1/events accepted");
  });
});
