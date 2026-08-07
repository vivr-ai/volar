#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createClient } from "@supabase/supabase-js";

// Issue 4.5 (Epic 4): internal CLI for adding a new PriceTable version.
//
// This is deliberately NOT part of the customer-facing product — it's a
// tool for the Volar team to run by hand (from a trusted machine, with
// the Supabase service_role key) whenever a provider changes their
// published pricing. Per PRD FR-8.2, price changes are always a new
// versioned row, never an edit to an existing row, so every past
// LLMCallEvent's cost stays correct against the price that was actually
// in effect when it happened (this is exactly what issue 4.4's
// resolvePriceForEvent depends on).
//
// Usage:
//   pnpm --filter @volar/internal-cli run add-price-version -- \
//     --provider anthropic --model claude-sonnet-5 \
//     --effective-from 2026-09-01T00:00:00Z \
//     --input-price 0.0030 --output-price 0.0150
//
// Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment
// (see .env.example) — the service_role key is required because
// price_table's RLS (issue 4.1) deliberately grants no INSERT policy to
// `authenticated`; only elevated/internal tooling can write here.

export const SUPPORTED_PROVIDERS = ["openai", "anthropic"] as const;
export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

export interface AddPriceVersionArgs {
  provider: string;
  model: string;
  effectiveFrom: string;
  inputPrice: string;
  outputPrice: string;
  source?: string;
  version?: string;
}

export interface ValidatedPriceVersion {
  provider: SupportedProvider;
  model: string;
  effectiveFromIso: string;
  inputPricePer1kTokensUsd: number;
  outputPricePer1kTokensUsd: number;
  source: string;
  explicitVersion?: number;
}

/**
 * Validates raw CLI input before anything touches the database. Kept as
 * a pure function (no I/O) so it's unit-testable without a live
 * Supabase connection, and so an operator gets a specific, actionable
 * error rather than a raw Postgres constraint violation.
 */
export function validateArgs(args: AddPriceVersionArgs): ValidatedPriceVersion {
  if (!args.provider) {
    throw new Error("--provider is required");
  }
  if (!SUPPORTED_PROVIDERS.includes(args.provider as SupportedProvider)) {
    throw new Error(
      `--provider must be one of: ${SUPPORTED_PROVIDERS.join(", ")} (got "${args.provider}")`,
    );
  }
  if (!args.model || args.model.trim() === "") {
    throw new Error("--model is required");
  }
  if (!args.effectiveFrom) {
    throw new Error(
      "--effective-from is required (ISO 8601, e.g. 2026-09-01T00:00:00Z)",
    );
  }
  const effectiveFromMs = new Date(args.effectiveFrom).getTime();
  if (Number.isNaN(effectiveFromMs)) {
    throw new Error(
      `--effective-from is not a valid timestamp: "${args.effectiveFrom}"`,
    );
  }

  const inputPrice = parsePrice(args.inputPrice, "--input-price");
  const outputPrice = parsePrice(args.outputPrice, "--output-price");

  let explicitVersion: number | undefined;
  if (args.version !== undefined) {
    explicitVersion = Number(args.version);
    if (!Number.isInteger(explicitVersion) || explicitVersion < 1) {
      throw new Error(
        `--version must be a positive integer (got "${args.version}")`,
      );
    }
  }

  return {
    provider: args.provider as SupportedProvider,
    model: args.model.trim(),
    effectiveFromIso: new Date(effectiveFromMs).toISOString(),
    inputPricePer1kTokensUsd: inputPrice,
    outputPricePer1kTokensUsd: outputPrice,
    source:
      args.source && args.source.trim() !== ""
        ? args.source.trim()
        : "provider-published-pricing-page",
    explicitVersion,
  };
}

function parsePrice(raw: string | undefined, flagName: string): number {
  if (raw === undefined || raw === "") {
    throw new Error(`${flagName} is required`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${flagName} must be a non-negative number (got "${raw}")`);
  }
  return value;
}

/**
 * Given the version numbers already on record for this exact
 * (provider, model), decides the new row's version, or throws if the
 * caller explicitly asked for a version that already exists — this is
 * the "refuses to create a duplicate (provider, model, version)"
 * acceptance criterion. Pure and unit-tested; the DB's own
 * unique(provider, model, version) constraint from issue 4.1 is a
 * backstop, not the primary defense — an operator should see a clear
 * error before any SQL runs. (Both the app-level refusal and the DB
 * constraint backstop were verified directly against the real database
 * as part of this issue's closing verification.)
 */
export function resolveVersion(
  existingVersions: readonly number[],
  explicitVersion: number | undefined,
): number {
  if (explicitVersion !== undefined) {
    if (existingVersions.includes(explicitVersion)) {
      throw new Error(
        `version ${explicitVersion} already exists for this provider/model — refusing to overwrite. ` +
          `Existing versions: ${existingVersions
            .slice()
            .sort((a, b) => a - b)
            .join(", ")}`,
      );
    }
    return explicitVersion;
  }
  if (existingVersions.length === 0) {
    return 1;
  }
  return Math.max(...existingVersions) + 1;
}

async function main() {
  const { values } = parseArgs({
    options: {
      provider: { type: "string" },
      model: { type: "string" },
      "effective-from": { type: "string" },
      "input-price": { type: "string" },
      "output-price": { type: "string" },
      source: { type: "string" },
      version: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });

  const validated = validateArgs({
    provider: values.provider ?? "",
    model: values.model ?? "",
    effectiveFrom: values["effective-from"] ?? "",
    inputPrice: values["input-price"] ?? "",
    outputPrice: values["output-price"] ?? "",
    source: values.source,
    version: values.version,
  });

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in the environment " +
        "(see packages/internal-cli/.env.example) — this tool requires the " +
        "service_role key because price_table grants no INSERT policy to " +
        "regular authenticated users.",
    );
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const { data: existingRows, error: fetchError } = await supabase
    .from("price_table")
    .select("version")
    .eq("provider", validated.provider)
    .eq("model", validated.model);

  if (fetchError) {
    throw new Error(`Failed to look up existing versions: ${fetchError.message}`);
  }

  const existingVersions = (existingRows ?? []).map(
    (row: { version: number }) => row.version,
  );
  const version = resolveVersion(existingVersions, validated.explicitVersion);

  const newRow = {
    provider: validated.provider,
    model: validated.model,
    effective_from: validated.effectiveFromIso,
    input_price_per_1k_tokens_usd: validated.inputPricePer1kTokensUsd,
    output_price_per_1k_tokens_usd: validated.outputPricePer1kTokensUsd,
    version,
    source: validated.source,
  };

  console.log(
    "About to insert a new price_table row (existing rows are never modified):",
  );
  console.log(JSON.stringify(newRow, null, 2));

  if (values["dry-run"]) {
    console.log("--dry-run set: no row was inserted.");
    return;
  }

  const { data: inserted, error: insertError } = await supabase
    .from("price_table")
    .insert(newRow)
    .select()
    .single();

  if (insertError) {
    throw new Error(`Insert failed: ${insertError.message}`);
  }

  console.log(`Inserted price_table row id=${inserted.id}, version=${inserted.version}.`);
}

// Only run main() when this file is executed directly — keeps the pure
// helpers above importable by the test suite without triggering a real
// network call or requiring env vars to be set just to run tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(
      `add-price-version failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
  });
}
