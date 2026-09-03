import type { SupabaseClient } from "@supabase/supabase-js";
import { generateApiKey, hashApiKey } from "@volar/shared";

// Issue 7.5: self-provisions a fresh org + N projects + N real,
// working API keys for a single load-test run, using the exact same
// generateApiKey()/hashApiKey() functions the real signup path uses
// (packages/shared/src/api-key.ts) -- so the real auth middleware
// (issue 6.2) accepts these keys with zero special-casing, and the
// burst genuinely exercises production auth, not a bypass.
//
// A real course-correction, flagged here per the Working Agreement:
// this issue's first draft (mid-session, before this file was written)
// seeded one *persistent* "Load Test Org" with 10 keys directly via SQL
// and intended to commit their plaintext into this repo so the script
// could reuse them across runs. That was wrong on reflection -- it
// would have meant a long-lived, real, working credential sitting in
// git history indefinitely, which is exactly the kind of secret-hygiene
// mistake this project's own operating rules exist to prevent, and it
// also broke from this codebase's own established convention: every
// other fixture in docs/RLS.md is explicitly disposable, deleted right
// after the verification that needed it. That persistent seed data
// (org, 10 projects, 10 keys) was deleted from the live Supabase
// project before this file was written -- nothing from that first
// attempt was ever committed. This module replaces it: every run gets
// its own fresh org/projects/keys, held in memory only for the
// duration of that run, and teardownLoadTestFixtures below deletes them
// again once the run finishes (or fails -- see the CLI entrypoint's
// try/finally).

export interface ProvisionedProject {
  projectId: string;
  apiKeyId: string;
  /** Shown once, held only in memory -- never written to disk, logged,
   * or returned to a caller that might persist it. */
  plaintextKey: string;
}

export interface ProvisionedFixtures {
  organizationId: string;
  projects: ProvisionedProject[];
}

const LOAD_TEST_ORG_NAME_PREFIX = "Load Test Org (issue 7.5)";

export async function provisionLoadTestFixtures(
  supabase: SupabaseClient,
  projectCount: number,
): Promise<ProvisionedFixtures> {
  const runLabel = new Date().toISOString();

  const { data: org, error: orgError } = await supabase
    .from("organizations")
    .insert({ name: `${LOAD_TEST_ORG_NAME_PREFIX} ${runLabel}` })
    .select("id")
    .single();

  if (orgError || !org) {
    throw new Error(`Failed to provision load-test organization: ${orgError?.message}`);
  }
  const organizationId = (org as { id: string }).id;

  const projects: ProvisionedProject[] = [];
  for (let i = 0; i < projectCount; i++) {
    const { data: project, error: projectError } = await supabase
      .from("projects")
      .insert({ organization_id: organizationId, name: `Load Test Project ${i}` })
      .select("id")
      .single();

    if (projectError || !project) {
      throw new Error(`Failed to provision load-test project ${i}: ${projectError?.message}`);
    }
    const projectId = (project as { id: string }).id;

    const { fullKey, keyPrefix } = generateApiKey();
    const hashedKey = hashApiKey(fullKey);

    const { data: apiKey, error: apiKeyError } = await supabase
      .from("api_keys")
      .insert({ project_id: projectId, key_prefix: keyPrefix, hashed_key: hashedKey })
      .select("id")
      .single();

    if (apiKeyError || !apiKey) {
      throw new Error(
        `Failed to provision load-test API key for project ${i}: ${apiKeyError?.message}`,
      );
    }

    projects.push({
      projectId,
      apiKeyId: (apiKey as { id: string }).id,
      plaintextKey: fullKey,
    });
  }

  return { organizationId, projects };
}

/**
 * Deletes everything provisionLoadTestFixtures created for one run, in
 * FK-safe order (api_keys -> projects -> organizations). Always called
 * from the CLI entrypoint's try/finally, so a mid-run failure still
 * cleans up rather than leaking rows into a future run's queries.
 */
export async function teardownLoadTestFixtures(
  supabase: SupabaseClient,
  fixtures: ProvisionedFixtures,
): Promise<void> {
  const projectIds = fixtures.projects.map((p) => p.projectId);

  if (projectIds.length > 0) {
    const { error: keyError } = await supabase.from("api_keys").delete().in("project_id", projectIds);
    if (keyError) {
      throw new Error(`Failed to delete load-test API keys: ${keyError.message}`);
    }

    const { error: projectError } = await supabase.from("projects").delete().in("id", projectIds);
    if (projectError) {
      throw new Error(`Failed to delete load-test projects: ${projectError.message}`);
    }
  }

  const { error: orgError } = await supabase
    .from("organizations")
    .delete()
    .eq("id", fixtures.organizationId);
  if (orgError) {
    throw new Error(`Failed to delete load-test organization: ${orgError.message}`);
  }
}
