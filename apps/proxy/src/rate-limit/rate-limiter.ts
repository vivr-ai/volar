// Issue 6.5 (Epic 6 -- Ingestion API): rate limiting / abuse protection.
//
// AC1: "Requests beyond the configured threshold receive a 429 with a
// Retry-After header."
// AC2: "Rate limit is per API key, not global."
// AC3: "Limit is generous enough not to interfere with expected
// design-partner traffic (documented threshold)."
//
// Same two-layer split as 6.2's authenticateApiKey /
// evaluateApiKeyCandidates and 4.4's resolvePriceForEvent:
//   - checkRateLimit(): pure decision logic (fixed-window counting and
//     the allow/block call), unit-testable with a plain in-memory map
//     and an injected clock -- no I/O, no timers.
//   - createInMemoryRateLimitStore(): the one concrete store
//     implementation wired in for V1.
//
// Algorithm: fixed window, not a sliding window or token bucket. A
// deliberate simplification for a "Medium" risk, "basic" abuse-
// protection issue (per build_backlog.py's own framing) -- fixed window
// is trivial to reason about and test deterministically with an
// injected `now`, at the known cost that a client can burst up to
// ~2x the limit across a window boundary (e.g. `limit` requests in the
// last instant of one window plus `limit` more in the first instant of
// the next). That's an accepted tradeoff for "protect the proxy from a
// runaway client loop" (the issue's own framing) -- a runaway loop
// produces sustained, not boundary-timed, traffic, so fixed window
// still catches the case this issue actually exists to catch. Revisit
// only if real abuse patterns ever specifically exploit the boundary.
//
// Storage: in-memory, per-proxy-process. PRD NFR §10.4 places a shared
// queue (Upstash Redis/QStash or Supabase-native) in the architecture
// specifically "to decouple ingestion rate from write rate" for burst
// handling -- but that queue doesn't exist yet (it's Epic 7's
// territory; apps/proxy/.env.example even documents the Upstash env
// vars as "reserved for Epic 7, not yet wired into code"). Until that
// queue (or some other shared store) exists, a per-process in-memory
// map is the only option, which means a multi-instance deployment of
// the proxy would give each instance its own independent budget per
// key rather than one shared budget. Flagged here as a known V1
// limitation, not silently assumed away: acceptable for now because
// (a) this issue's stated goal is protecting a single proxy process
// from a runaway loop, which an in-memory counter does regardless of
// instance count, and (b) RateLimitStore is defined as an interface
// specifically so a future Redis-backed implementation (natural to add
// alongside Epic 7's queue work) can swap in later without touching
// checkRateLimit's decision logic at all.
//
// Threshold (AC3's "documented threshold"): 300 requests / 60 seconds
// per API key. Reasoning, since no number is specified anywhere in the
// frozen PRD/backlog:
//   - FR-6.8: the SDK batches locally over "2-5 seconds or N events,
//     whichever first" before flushing -- so a single SDK instance in
//     one customer process produces at most ~1 ingestion request every
//     2s under sustained load, i.e. ~30 req/min.
//   - A design partner may run multiple concurrent instances of their
//     own application (horizontal scaling) all sharing one project's
//     API key, each batching independently. 300 req/min gives headroom
//     for roughly 10 such concurrent instances flushing every 2s --
//     generous for "design-partner traffic" (V1's actual current
//     scale: a handful of early customers, not enterprise fleets)
//     while still bounding a genuine bug (e.g. a customer accidentally
//     calling the ingestion endpoint synchronously per LLM call instead
//     of batching, which would spike into the thousands/min and trip
//     this limit well before it could do real damage).
//   - This is a judgment call, exactly as AC3 itself invites ("generous
//     enough... (documented threshold)") -- revisit once real
//     design-partner traffic is observed (Epic 19 observability) or
//     once issue 7.5's load test exercises this path directly.

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until the current window resets. Only meaningful -- and
   * only populated with a real value -- when `allowed` is false; it's
   * the value the 429 response's Retry-After header should carry. */
  retryAfterSeconds: number;
}

export interface RateLimitWindowState {
  windowStart: number;
  count: number;
}

/**
 * The storage boundary for rate-limit counters, kept as an interface
 * (not a concrete Map) specifically so a future shared/distributed
 * store (e.g. Redis, once Epic 7's queue work lands) can implement the
 * same shape without checkRateLimit changing at all -- see this file's
 * header comment.
 */
export interface RateLimitStore {
  get(key: string): RateLimitWindowState | undefined;
  set(key: string, state: RateLimitWindowState): void;
}

export interface RateLimitConfig {
  /** Max requests allowed per key within one window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

/** AC3's "documented threshold" -- see this file's header comment for
 * the full reasoning. Exported so index.ts (the real server) and tests
 * both reference the same real value rather than each hardcoding their
 * own copy of the number. */
export const DEFAULT_INGESTION_RATE_LIMIT_CONFIG: RateLimitConfig = {
  limit: 300,
  windowMs: 60_000,
};

/**
 * Pure decision logic -- no I/O, fully deterministic given `now` and
 * whatever `store` currently holds. See rate-limiter.test.ts for the
 * fixture-driven unit tests covering AC1/AC2.
 *
 * Increments and checks atomically from the caller's point of view:
 * every call to checkRateLimit counts as one request against `key`,
 * whether or not it turns out to be the one that exceeds the limit --
 * a rejected request still consumes its slot rather than being
 * "free," matching standard fixed-window rate-limiter semantics.
 */
export function checkRateLimit(
  store: RateLimitStore,
  key: string,
  now: number,
  config: RateLimitConfig,
): RateLimitDecision {
  const windowStart = Math.floor(now / config.windowMs) * config.windowMs;
  const existing = store.get(key);

  const count = existing && existing.windowStart === windowStart ? existing.count + 1 : 1;
  store.set(key, { windowStart, count });

  if (count > config.limit) {
    const resetAtMs = windowStart + config.windowMs;
    // Always at least 1s -- a Retry-After of 0 is a meaningless
    // instruction to the caller, and `now` can equal resetAtMs exactly
    // in edge-case timing.
    const retryAfterSeconds = Math.max(1, Math.ceil((resetAtMs - now) / 1000));
    return { allowed: false, retryAfterSeconds };
  }

  return { allowed: true, retryAfterSeconds: 0 };
}

/**
 * The V1 concrete store -- an unbounded-lifetime in-memory Map keyed by
 * API key ID. Memory usage is proportional to the number of distinct
 * API keys ever seen by this process, not to elapsed time or request
 * volume (each key's entry is overwritten in place every window
 * rollover, never appended to) -- acceptable at V1's scale (a handful
 * of design-partner projects, each with a small number of keys per
 * PRD/backlog's Epic 3 data model), and naturally superseded once a
 * shared/TTL'd store (e.g. Redis) arrives alongside Epic 7's queue
 * work.
 */
export function createInMemoryRateLimitStore(): RateLimitStore {
  const map = new Map<string, RateLimitWindowState>();
  return {
    get: (key) => map.get(key),
    set: (key, state) => {
      map.set(key, state);
    },
  };
}
