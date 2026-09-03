import { randomUUID } from "node:crypto";
import { SUPPORTED_INGESTION_PROVIDERS, type IngestionEventPayload } from "@volar/shared";

// Issue 7.5: builds a single synthetic, but wire-valid, ingestion event
// -- passes ingestionEventPayloadSchema unchanged (issue 6.3), so the
// load test exercises the exact same validation/enqueue/worker path a
// real SDK delivery would, not a shortcut around it.

// Model names deliberately match public.price_table's live rows exactly
// (verified against the real project, not guessed) -- issue 5.3's
// resolvePriceForEvent() stores a null computed_cost_usd *and* fires a
// [volar:pricing-gap] alert for any (provider, model) it can't resolve
// a price for (by design: never blocks the insert). An earlier draft of
// this file used stale placeholder names ("gpt-4o", "claude-haiku-4-5")
// that don't exist in price_table, which spammed that alert on every
// event during this issue's live verification run -- confirmed via
// Railway logs, then fixed here by checking the live table instead of
// guessing. Revisit if price_table's rows change.
const MODELS_BY_PROVIDER: Record<(typeof SUPPORTED_INGESTION_PROVIDERS)[number], string[]> = {
  openai: ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"],
  anthropic: ["claude-sonnet-5", "claude-opus-5", "claude-haiku-4-5-20251001"],
};

export interface GenerateEventOptions {
  /** Defaults to crypto.randomUUID(). Tests inject a fixed value so
   * assertions don't depend on real randomness. */
  eventId?: string;
  /** Defaults to () => new Date(). Tests inject a fixed clock. */
  now?: () => Date;
  /** Defaults to Math.random. Tests inject a deterministic sequence so
   * provider/model/token-count selection is assertable. */
  random?: () => number;
}

export function buildLoadTestEvent(options: GenerateEventOptions = {}): IngestionEventPayload {
  const random = options.random ?? Math.random;
  const now = options.now ?? (() => new Date());

  const provider =
    SUPPORTED_INGESTION_PROVIDERS[Math.floor(random() * SUPPORTED_INGESTION_PROVIDERS.length)];
  const models = MODELS_BY_PROVIDER[provider];
  const model = models[Math.floor(random() * models.length)];

  return {
    event_id: options.eventId ?? randomUUID(),
    provider,
    model,
    input_tokens: 50 + Math.floor(random() * 950),
    output_tokens: 20 + Math.floor(random() * 480),
    timestamp: now().toISOString(),
    customer_id: `load-test-customer-${Math.floor(random() * 20)}`,
    feature_id: "load-test",
    status: "success",
  };
}
