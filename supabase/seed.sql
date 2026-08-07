-- Issue 4.2 (Epic 4): initial PriceTable seed data.
--
-- Every price below is sourced directly from each provider's official,
-- published pricing / model-catalog page, fetched 2026-08-07. See
-- docs/PRICE_TABLE.md for the full citation list, exact source URLs, and
-- the rationale for this initial model selection (the PRD deliberately
-- doesn't name specific models — it only requires OpenAI Chat Completions
-- and Anthropic Messages API support, PRD FR-6.7).
--
-- Idempotent (issue 4.2 AC1): `on conflict (provider, model, version) do
-- nothing` means re-running this file never duplicates a row or errors,
-- even if some or all rows already exist — this is run automatically by
-- `supabase db reset` locally (see supabase/config.toml's
-- [db.seed] sql_paths), so it needs to tolerate being re-run freely.
--
-- effective_from uses 2026-08-07 (the date this seed was written) for
-- every "current" price, since no historical LLMCallEvent rows exist yet
-- (that table doesn't exist until Epic 6) that would need a backdated
-- price to stay accurate.

insert into public.price_table
  (provider, model, effective_from, input_price_per_1k_tokens_usd, output_price_per_1k_tokens_usd, version, source)
values
  -- OpenAI — model IDs from https://developers.openai.com/api/docs/models,
  -- prices confirmed against https://openai.com/api/pricing (both agree),
  -- fetched 2026-08-07.
  ('openai', 'gpt-5.6-sol',   '2026-08-07T00:00:00Z', 0.0050, 0.0300, 1, 'provider-published-pricing-page'),
  ('openai', 'gpt-5.6-terra', '2026-08-07T00:00:00Z', 0.0020, 0.0120, 1, 'provider-published-pricing-page'),
  ('openai', 'gpt-5.6-luna',  '2026-08-07T00:00:00Z', 0.0002, 0.0012, 1, 'provider-published-pricing-page'),

  -- Anthropic — model IDs and pricing from
  -- https://platform.claude.com/docs/en/about-claude/models/overview and
  -- .../about-claude/pricing, fetched 2026-08-07.
  ('anthropic', 'claude-opus-5', '2026-08-07T00:00:00Z', 0.0050, 0.0250, 1, 'provider-published-pricing-page'),

  -- Claude Sonnet 5 has a published, dated price change — a real example
  -- of exactly what PriceTable's append-only versioning (PRD FR-8.2)
  -- exists for. Version 1 is the introductory price in effect now;
  -- version 2 is the standard price Anthropic has already announced
  -- takes effect 2026-09-01. Both are seeded now with their real
  -- effective dates rather than waiting until September to add the second.
  ('anthropic', 'claude-sonnet-5', '2026-08-07T00:00:00Z', 0.0020, 0.0100, 1, 'provider-published-pricing-page'),
  ('anthropic', 'claude-sonnet-5', '2026-09-01T00:00:00Z', 0.0030, 0.0150, 2, 'provider-published-pricing-page'),

  -- Haiku 4.5 predates Anthropic's dateless model-ID convention (used
  -- from the 4.6 generation onward), so its real API model ID includes a
  -- date suffix even though the human-facing alias ("claude-haiku-4-5")
  -- doesn't. Stored here as the full pinned ID since that's what a real
  -- API response's `model` field will contain.
  ('anthropic', 'claude-haiku-4-5-20251001', '2026-08-07T00:00:00Z', 0.0010, 0.0050, 1, 'provider-published-pricing-page')
on conflict (provider, model, version) do nothing;
