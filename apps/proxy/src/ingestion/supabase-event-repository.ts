import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { PriceTableRow } from "@volar/shared";
import type {
  InsertEventOutcome,
  LLMCallEventInsertRow,
  WriteLlmCallEventDeps,
} from "./write-llm-call-event.js";

// Real Supabase-backed wiring for writeLlmCallEvent's WriteLlmCallEventDeps
// (issue 5.2, extended by issues 5.3/5.4). Thin and mechanical on
// purpose -- all actual logic lives in write-llm-call-event.ts's pure
// orchestration function; this file only translates that function's
// DB-facing I/O calls into real Supabase queries. Consumed by the
// future ingestion endpoint (issue 6.1) and queue worker (issue 7.3),
// both of which need the same DB wiring.
//
// Requires a client authenticated with the service_role key -- RLS on
// both price_table (issue 4.1) and llm_call_events (issue 5.1)
// deliberately grants no write access to `authenticated`/`anon`.

interface PriceTableRowFromDb {
  provider: string;
  model: string;
  effective_from: string;
  version: number;
  input_price_per_1k_tokens_usd: string;
  output_price_per_1k_tokens_usd: string;
}

// Deliberately returns only the two DB-facing members of
// WriteLlmCallEventDeps -- alerting (issue 5.3) is a separate concern
// (see alerts.ts) that callers merge in themselves, e.g.:
//   {
//     ...createSupabaseEventWriteDeps(supabase),
//     alertPriceUnresolved: alertPriceUnresolvedViaConsole,
//   }
export function createSupabaseEventWriteDeps(
  supabase: SupabaseClient,
): Omit<WriteLlmCallEventDeps, "alertPriceUnresolved"> {
  return {
    async fetchPriceRows(provider, model): Promise<readonly PriceTableRow[]> {
      const { data, error } = await supabase
        .from("price_table")
        .select(
          "provider, model, effective_from, version, input_price_per_1k_tokens_usd, output_price_per_1k_tokens_usd",
        )
        .eq("provider", provider)
        .eq("model", model);

      if (error) {
        throw new Error(`Failed to fetch price_table rows: ${error.message}`);
      }

      return ((data ?? []) as PriceTableRowFromDb[]).map((row) => ({
        provider: row.provider,
        model: row.model,
        effectiveFrom: row.effective_from,
        version: row.version,
        inputPricePer1kTokensUsd: row.input_price_per_1k_tokens_usd,
        outputPricePer1kTokensUsd: row.output_price_per_1k_tokens_usd,
      }));
    },

    // Issue 5.4: insert-or-ignore keyed on the unique(event_id)
    // constraint. `ignoreDuplicates: true` turns this into
    // `INSERT ... ON CONFLICT (event_id) DO NOTHING` -- on a duplicate,
    // PostgREST returns zero rows (not an error), so we fall back to
    // selecting the already-stored row and report its real, canonical
    // id/cost back to the caller rather than an empty result.
    async insertEvent(row: LLMCallEventInsertRow): Promise<InsertEventOutcome> {
      const { data, error } = await supabase
        .from("llm_call_events")
        .upsert(row, { onConflict: "event_id", ignoreDuplicates: true })
        .select("id, computed_cost_usd");

      if (error) {
        throw new Error(`Failed to insert llm_call_events row: ${error.message}`);
      }

      if (data && data.length > 0) {
        const inserted = data[0] as { id: string; computed_cost_usd: string | null };
        return { id: inserted.id, costUsd: inserted.computed_cost_usd, wasDuplicate: false };
      }

      const { data: existing, error: fetchError } = await supabase
        .from("llm_call_events")
        .select("id, computed_cost_usd")
        .eq("event_id", row.event_id)
        .single();

      if (fetchError) {
        throw new Error(
          `event_id conflicted but failed to fetch the existing row: ${fetchError.message}`,
        );
      }

      const existingRow = existing as { id: string; computed_cost_usd: string | null };
      return { id: existingRow.id, costUsd: existingRow.computed_cost_usd, wasDuplicate: true };
    },
  };
}

/**
 * Builds a Supabase client authenticated with the service_role key from
 * the environment. Throws immediately (rather than deferring to the
 * first failed query) if the required env vars are missing, so a
 * misconfigured deployment fails loudly at startup.
 */
export function createServiceRoleSupabaseClient(): SupabaseClient {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (see apps/proxy/.env.example).",
    );
  }
  return createClient(supabaseUrl, serviceRoleKey);
}
