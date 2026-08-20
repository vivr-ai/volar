import { describe, expect, it } from "vitest";
import { checkRateLimit, createInMemoryRateLimitStore, type RateLimitConfig } from "./rate-limiter.js";

const CONFIG: RateLimitConfig = { limit: 3, windowMs: 60_000 };
// Computed (not hand-picked) so it's *actually* aligned to a windowMs
// boundary regardless of windowMs's value -- an arbitrary-looking
// literal here previously caused a subtle test bug (see git history):
// 1_700_000_000_000 looks round but isn't a multiple of 60_000, so
// "45s into the window" math was silently off by 20s.
const WINDOW_START = Math.floor(1_700_000_000_000 / CONFIG.windowMs) * CONFIG.windowMs;

describe("checkRateLimit", () => {
  it("allows requests at and under the limit", () => {
    const store = createInMemoryRateLimitStore();

    for (let i = 0; i < CONFIG.limit; i++) {
      const decision = checkRateLimit(store, "key-a", WINDOW_START + i, CONFIG);
      expect(decision.allowed).toBe(true);
    }
  });

  // AC1: "Requests beyond the configured threshold receive a 429 with a
  // Retry-After header." (the header itself is added at the route
  // layer -- see events.test.ts -- this is the underlying decision.)
  it("blocks the request that pushes the count over the limit", () => {
    const store = createInMemoryRateLimitStore();

    for (let i = 0; i < CONFIG.limit; i++) {
      checkRateLimit(store, "key-a", WINDOW_START + i, CONFIG);
    }
    const decision = checkRateLimit(store, "key-a", WINDOW_START + CONFIG.limit, CONFIG);

    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("computes retryAfterSeconds as the time remaining until the window resets", () => {
    const store = createInMemoryRateLimitStore();
    const requestTime = WINDOW_START + 45_000; // 45s into a 60s window

    for (let i = 0; i < CONFIG.limit; i++) {
      checkRateLimit(store, "key-a", requestTime, CONFIG);
    }
    const decision = checkRateLimit(store, "key-a", requestTime, CONFIG);

    // Window resets at WINDOW_START + 60_000; 15s remain.
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSeconds).toBe(15);
  });

  it("never returns a retryAfterSeconds below 1, even at the exact reset instant", () => {
    const store = createInMemoryRateLimitStore();
    const resetInstant = WINDOW_START + CONFIG.windowMs;

    for (let i = 0; i < CONFIG.limit; i++) {
      checkRateLimit(store, "key-a", resetInstant, CONFIG);
    }
    const decision = checkRateLimit(store, "key-a", resetInstant, CONFIG);

    expect(decision.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it("resets the count once a new window begins", () => {
    const store = createInMemoryRateLimitStore();

    for (let i = 0; i < CONFIG.limit; i++) {
      checkRateLimit(store, "key-a", WINDOW_START + i, CONFIG);
    }
    // Blocked at the end of window 1.
    expect(checkRateLimit(store, "key-a", WINDOW_START + CONFIG.limit, CONFIG).allowed).toBe(false);

    // A request in the next window gets a fresh budget.
    const nextWindow = WINDOW_START + CONFIG.windowMs;
    expect(checkRateLimit(store, "key-a", nextWindow, CONFIG).allowed).toBe(true);
  });

  // AC2: "Rate limit is per API key, not global."
  it("tracks separate budgets per key", () => {
    const store = createInMemoryRateLimitStore();

    for (let i = 0; i < CONFIG.limit; i++) {
      checkRateLimit(store, "key-a", WINDOW_START + i, CONFIG);
    }
    // key-a is now exhausted for this window...
    expect(checkRateLimit(store, "key-a", WINDOW_START, CONFIG).allowed).toBe(false);
    // ...but key-b has never been charged, so it still has its full
    // budget in the very same window.
    expect(checkRateLimit(store, "key-b", WINDOW_START, CONFIG).allowed).toBe(true);
  });

  it("a rejected request still consumes a slot (doesn't reset the count)", () => {
    const store = createInMemoryRateLimitStore();

    for (let i = 0; i < CONFIG.limit + 2; i++) {
      checkRateLimit(store, "key-a", WINDOW_START + i, CONFIG);
    }
    const state = store.get("key-a");
    expect(state?.count).toBe(CONFIG.limit + 2);
  });
});
