import type { SupabaseClient } from "@supabase/supabase-js";
import type { ApiKeyCandidate, AuthenticateApiKeyDeps } from "./authenticate-api-key.js";

// Real Supabase-backed wiring for AuthenticateApiKeyDeps (issue 6.2).
// Thin and mechanical on purpose, same convention as
// ../ingestion/supabase-event-repository.ts -- all real decision logic
// lives in authenticate-api-key.ts's pure evaluateApiKeyCandidates();
// this file only translates fetchCandidatesByPrefix into two real
// queries against public.api_keys.
//
// Requires a client authenticated with the service_role key: RLS grants
// `authenticated`/`anon` no column access to hashed_key at all (issue
// 3.2's migration; reconfirmed live while closing this issue -- see
// docs/RLS.md), so only service_role can ever read what this needs to
// verify a presented key.
//
// Two queries rather than one PostgREST-embedded query, deliberately:
// api_keys.rotated_from_key_id is a *self*-referencing foreign key, and
// expressing "the row whose rotated_from_key_id points at me" as a
// PostgREST embed from the "me" side is awkward/fragile compared to two
// plain selects. Given candidates-by-prefix is virtually always 0 or 1
// row, the extra round trip is immaterial next to the NFR §10.2 budget.

interface ApiKeyRowFromDb {
  id: string;
  project_id: string;
  hashed_key: string;
  revoked_at: string | null;
}

interface SuccessorRowFromDb {
  rotated_from_key_id: string;
  created_at: string;
}

export function createSupabaseApiKeyAuthDeps(
  supabase: SupabaseClient,
): AuthenticateApiKeyDeps {
  return {
    async fetchCandidatesByPrefix(keyPrefix): Promise<readonly ApiKeyCandidate[]> {
      const { data, error } = await supabase
        .from("api_keys")
        .select("id, project_id, hashed_key, revoked_at")
        .eq("key_prefix", keyPrefix);

      if (error) {
        throw new Error(`Failed to fetch api_keys candidates: ${error.message}`);
      }

      const rows = (data ?? []) as ApiKeyRowFromDb[];
      if (rows.length === 0) {
        return [];
      }

      const candidateIds = rows.map((row) => row.id);
      const { data: successorData, error: successorError } = await supabase
        .from("api_keys")
        .select("rotated_from_key_id, created_at")
        .in("rotated_from_key_id", candidateIds);

      if (successorError) {
        throw new Error(
          `Failed to fetch api_keys rotation successors: ${successorError.message}`,
        );
      }

      // Maps an old key's id -> its successor's created_at (the moment
      // that starts the 24h grace-period clock for the old key). Guards
      // against the (should-never-happen, since rotated_from_key_id is
      // set once at row creation) case of two rows somehow claiming the
      // same predecessor by keeping the earliest created_at -- that's
      // the one that actually started the clock first.
      const successorCreatedAtByOldKeyId = new Map<string, string>();
      for (const successor of (successorData ?? []) as SuccessorRowFromDb[]) {
        const existing = successorCreatedAtByOldKeyId.get(successor.rotated_from_key_id);
        if (!existing || successor.created_at < existing) {
          successorCreatedAtByOldKeyId.set(successor.rotated_from_key_id, successor.created_at);
        }
      }

      return rows.map((row) => ({
        id: row.id,
        projectId: row.project_id,
        hashedKey: row.hashed_key,
        revokedAt: row.revoked_at,
        supersededByCreatedAt: successorCreatedAtByOldKeyId.get(row.id) ?? null,
      }));
    },
  };
}

/**
 * Issue 6.6: real Supabase-backed wiring for the fire-and-forget
 * last_used_at update -- a separate function from
 * createSupabaseApiKeyAuthDeps() (not folded into it) because the two
 * capabilities are consumed differently: fetchCandidatesByPrefix is
 * called synchronously, on the request's critical path, by
 * authenticateApiKey(); this is called by events.ts's preHandler
 * *without being awaited*, specifically so a slow or failed write here
 * can never add latency to (AC1) or fail (AC2) the actual request. Kept
 * in this file rather than events.ts because "how do I write to
 * api_keys" is this file's established job (same layering as
 * fetchCandidatesByPrefix above) -- "when/whether to call it, and
 * making sure it can't block the response" is the route layer's job,
 * exactly like issue 6.5's rate-limit deps.
 *
 * Verified directly against the live Supabase project while closing
 * this issue: seeded a disposable api_keys row with last_used_at null,
 * ran this exact UPDATE, confirmed last_used_at became non-null, then
 * deleted the row. service_role bypasses RLS entirely (same as every
 * other write in this file), so the table's read-only "Users can
 * select own organization api keys" policy has no bearing here.
 */
export function createTouchApiKeyLastUsedAt(
  supabase: SupabaseClient,
): (apiKeyId: string) => Promise<void> {
  return async function touchApiKeyLastUsedAt(apiKeyId: string): Promise<void> {
    const { error } = await supabase
      .from("api_keys")
      .update({ last_used_at: new Date().toISOString() })
      .eq("id", apiKeyId);

    if (error) {
      throw new Error(`Failed to update api_keys.last_used_at: ${error.message}`);
    }
  };
}
