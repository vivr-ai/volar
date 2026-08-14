import { describe, it, expect, vi } from "vitest";
import { hashApiKey } from "@volar/shared";
import {
  authenticateApiKey,
  evaluateApiKeyCandidates,
  type ApiKeyCandidate,
  type AuthenticateApiKeyDeps,
} from "./authenticate-api-key.js";

const NOW = new Date("2026-08-20T12:00:00.000Z");
const ONE_HOUR_MS = 60 * 60 * 1000;

function candidateFor(
  fullKey: string,
  overrides: Partial<Omit<ApiKeyCandidate, "hashedKey">> = {},
): ApiKeyCandidate {
  return {
    id: "key-id",
    projectId: "33333333-3333-3333-3333-333333333333",
    hashedKey: hashApiKey(fullKey),
    revokedAt: null,
    supersededByCreatedAt: null,
    ...overrides,
  };
}

describe("evaluateApiKeyCandidates (pure decision logic)", () => {
  // AC1: "Valid current key authenticates successfully"
  it("authenticates a valid, never-rotated, never-revoked key", () => {
    const fullKey = "vlr_live_activekey00000000000000000000000000";
    const candidate = candidateFor(fullKey, { id: "key-1", projectId: "proj-1" });

    const result = evaluateApiKeyCandidates(fullKey, [candidate], NOW);

    expect(result).toEqual({ authenticated: true, apiKeyId: "key-1", projectId: "proj-1" });
  });

  // AC2: "Key within its rotation grace period still authenticates"
  it("authenticates an old key when its successor was created less than 24h ago", () => {
    const fullKey = "vlr_live_oldkey000000000000000000000000000000";
    const successorCreatedAt = new Date(NOW.getTime() - ONE_HOUR_MS).toISOString();
    const candidate = candidateFor(fullKey, { supersededByCreatedAt: successorCreatedAt });

    const result = evaluateApiKeyCandidates(fullKey, [candidate], NOW);

    expect(result.authenticated).toBe(true);
  });

  it("authenticates an old key exactly at the 24h boundary (deadline itself still valid)", () => {
    const fullKey = "vlr_live_boundarykey0000000000000000000000000";
    const successorCreatedAt = new Date(NOW.getTime() - 24 * ONE_HOUR_MS).toISOString();
    const candidate = candidateFor(fullKey, { supersededByCreatedAt: successorCreatedAt });

    const result = evaluateApiKeyCandidates(fullKey, [candidate], NOW);

    expect(result.authenticated).toBe(true);
  });

  it("rejects an old key once its grace period has passed", () => {
    const fullKey = "vlr_live_expiredkey0000000000000000000000000";
    const successorCreatedAt = new Date(NOW.getTime() - 25 * ONE_HOUR_MS).toISOString();
    const candidate = candidateFor(fullKey, { supersededByCreatedAt: successorCreatedAt });

    const result = evaluateApiKeyCandidates(fullKey, [candidate], NOW);

    expect(result).toEqual({ authenticated: false, reason: "grace_period_expired" });
  });

  // AC3: "Revoked key is rejected immediately with a clear error"
  it("rejects a revoked key", () => {
    const fullKey = "vlr_live_revokedkey0000000000000000000000000";
    const candidate = candidateFor(fullKey, { revokedAt: "2026-08-19T00:00:00.000Z" });

    const result = evaluateApiKeyCandidates(fullKey, [candidate], NOW);

    expect(result).toEqual({ authenticated: false, reason: "revoked" });
  });

  it("reports 'revoked' (not 'grace_period_expired') for a key that is both revoked and past its grace period", () => {
    const fullKey = "vlr_live_bothkey0000000000000000000000000000";
    const candidate = candidateFor(fullKey, {
      revokedAt: "2026-08-19T00:00:00.000Z",
      supersededByCreatedAt: new Date(NOW.getTime() - 25 * ONE_HOUR_MS).toISOString(),
    });

    const result = evaluateApiKeyCandidates(fullKey, [candidate], NOW);

    expect(result).toEqual({ authenticated: false, reason: "revoked" });
  });

  // AC4: "Unknown key rejected without leaking whether the prefix exists"
  it("rejects with the same reason whether the prefix has zero candidates or a candidate with the wrong secret", () => {
    const knownPrefixKey = "vlr_live_knownprefix000000000000000000000000";
    const wrongSecret = "vlr_live_knownprefix999999999999999999999999";
    const candidate = candidateFor(knownPrefixKey);

    const noCandidates = evaluateApiKeyCandidates(wrongSecret, [], NOW);
    const wrongSecretAgainstRealRow = evaluateApiKeyCandidates(wrongSecret, [candidate], NOW);

    expect(noCandidates).toEqual({ authenticated: false, reason: "not_found" });
    expect(wrongSecretAgainstRealRow).toEqual({ authenticated: false, reason: "not_found" });
  });
});

describe("authenticateApiKey (orchestration)", () => {
  function makeDeps(candidates: readonly ApiKeyCandidate[]): {
    deps: AuthenticateApiKeyDeps;
    fetchCandidatesByPrefix: ReturnType<typeof vi.fn>;
  } {
    const fetchCandidatesByPrefix = vi.fn(async () => candidates);
    return { deps: { fetchCandidatesByPrefix }, fetchCandidatesByPrefix };
  }

  it("derives the prefix and passes it to fetchCandidatesByPrefix, then authenticates a match", async () => {
    const fullKey = "vlr_live_lookupmekey000000000000000000000000";
    const candidate = candidateFor(fullKey, { id: "key-42", projectId: "proj-42" });
    const { deps, fetchCandidatesByPrefix } = makeDeps([candidate]);

    const result = await authenticateApiKey(deps, fullKey, NOW);

    expect(fetchCandidatesByPrefix).toHaveBeenCalledWith("vlr_live_lookupme");
    expect(result).toEqual({ authenticated: true, apiKeyId: "key-42", projectId: "proj-42" });
  });

  // AC4, orchestration-level: a key that doesn't even look like a Volar
  // key must never reach the database at all.
  it("rejects a malformed key without calling fetchCandidatesByPrefix", async () => {
    const { deps, fetchCandidatesByPrefix } = makeDeps([]);

    const result = await authenticateApiKey(deps, "not-a-volar-key-at-all", NOW);

    expect(result).toEqual({ authenticated: false, reason: "not_found" });
    expect(fetchCandidatesByPrefix).not.toHaveBeenCalled();
  });

  it("defaults `now` to the real current time when not supplied", async () => {
    const fullKey = "vlr_live_realtimekey000000000000000000000000";
    const candidate = candidateFor(fullKey);
    const { deps } = makeDeps([candidate]);

    const result = await authenticateApiKey(deps, fullKey);

    expect(result.authenticated).toBe(true);
  });
});
