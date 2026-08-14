import { deriveKeyPrefixFromFullKey, verifyApiKey } from "@volar/shared";

// Issue 6.2 (Epic 6): API key auth middleware -- hash lookup, 24h
// rotation grace period, revocation.
//
// PRD US-5.1 AC2: rotating a key issues a new one and invalidates the
// old one "after a grace period [24-hour]", specifically so rotating a
// key doesn't instantly break a live production integration. AC3:
// revoking with no rotation stops the key authenticating immediately.
// The `api_keys` schema (issue 3.2 migration) has no `rotated_at`
// timestamp on the *old* key -- instead the *new* key's row carries
// `rotated_from_key_id` pointing back at the old one. So the grace-period
// clock for an old key is anchored to its successor's created_at, not to
// anything stored on the old row itself -- see evaluateApiKeyCandidates
// below.
//
// Split into two layers, same shape as issue 4.4's resolvePriceForEvent
// / 5.2's writeLlmCallEvent:
//   - evaluateApiKeyCandidates(): pure decision logic (hash matching,
//     revocation, grace-period math), unit-testable with plain fixtures,
//     no I/O.
//   - authenticateApiKey(): thin orchestration that derives the lookup
//     prefix and calls the injected fetchCandidatesByPrefix, so tests
//     can supply an in-memory fake instead of a real Supabase client
//     (the real one is supabase-api-key-repository.ts).
//
// Verified directly against the live Supabase project while closing
// this issue (not just unit-tested against fakes) -- see docs/RLS.md's
// "API Keys" section for the six real rows seeded/queried/deleted and
// the exact outcomes observed, per the Working Agreement's testing
// discipline for anything touching this table.

/** 24 hours, per PRD US-5.1 AC2's explicit decision. */
export const ROTATION_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;

export interface ApiKeyCandidate {
  id: string;
  projectId: string;
  hashedKey: string;
  revokedAt: string | null;
  /**
   * created_at of the row (if any) whose rotated_from_key_id points at
   * this candidate -- i.e. this key's successor, if it was ever rotated
   * away from. Null if this key has never been rotated.
   */
  supersededByCreatedAt: string | null;
}

export type ApiKeyAuthResult =
  | { authenticated: true; apiKeyId: string; projectId: string }
  | {
      authenticated: false;
      /**
       * Internal-only -- never surface this distinction to the HTTP
       * response for "not_found" vs. a wrong-secret match on a real
       * prefix (AC4: unknown key rejected without leaking whether the
       * prefix exists). "revoked" and "grace_period_expired" *can* be
       * surfaced with a specific message (AC3: "rejected immediately
       * with a clear error") because reaching either of those branches
       * requires the presented key to have actually hashed-matched a
       * real row -- i.e. the caller genuinely possesses (or possessed)
       * that exact secret, so telling them "revoked" leaks nothing an
       * attacker without the secret could ever observe.
       */
      reason: "not_found" | "revoked" | "grace_period_expired";
    };

export interface AuthenticateApiKeyDeps {
  /**
   * Fetches every api_keys row sharing the presented key's non-secret
   * prefix (0, 1, or -- astronomically unlikely -- more than one row),
   * each annotated with its rotation successor's created_at if it has
   * one. See supabase-api-key-repository.ts for the real implementation.
   */
  fetchCandidatesByPrefix: (
    keyPrefix: string,
  ) => Promise<readonly ApiKeyCandidate[]>;
}

export async function authenticateApiKey(
  deps: AuthenticateApiKeyDeps,
  presentedKey: string,
  now: Date = new Date(),
): Promise<ApiKeyAuthResult> {
  const keyPrefix = deriveKeyPrefixFromFullKey(presentedKey);
  if (!keyPrefix) {
    // Not even shaped like a Volar key -- reject without touching the
    // database (also keeps this path fast, helping the NFR §10.2
    // latency budget on the overwhelmingly common "garbage credential"
    // case, e.g. a stray Authorization header from some other service).
    return { authenticated: false, reason: "not_found" };
  }

  const candidates = await deps.fetchCandidatesByPrefix(keyPrefix);
  return evaluateApiKeyCandidates(presentedKey, candidates, now);
}

/**
 * Pure decision logic -- no I/O, fully deterministic given `now`. See
 * authenticate-api-key.test.ts for the fixture-driven unit tests
 * covering AC1-AC4, and docs/RLS.md for this same logic re-run by hand
 * against real rows fetched from the live database.
 */
export function evaluateApiKeyCandidates(
  presentedKey: string,
  candidates: readonly ApiKeyCandidate[],
  now: Date,
): ApiKeyAuthResult {
  const match = candidates.find((candidate) =>
    verifyApiKey(presentedKey, candidate.hashedKey),
  );

  if (!match) {
    return { authenticated: false, reason: "not_found" };
  }

  // AC3: an explicitly revoked key is rejected immediately -- checked
  // before the grace-period branch below so a key that happens to be
  // both revoked *and* rotated always reports "revoked" (the more
  // specific, more recently-actioned fact), never
  // "grace_period_expired".
  if (match.revokedAt !== null) {
    return { authenticated: false, reason: "revoked" };
  }

  if (match.supersededByCreatedAt !== null) {
    const graceDeadline =
      new Date(match.supersededByCreatedAt).getTime() + ROTATION_GRACE_PERIOD_MS;
    // AC2: still within the 24h window -- old key stays valid.
    if (now.getTime() > graceDeadline) {
      return { authenticated: false, reason: "grace_period_expired" };
    }
  }

  return { authenticated: true, apiKeyId: match.id, projectId: match.projectId };
}
