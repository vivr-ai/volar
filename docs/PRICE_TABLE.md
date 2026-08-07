# PriceTable — Initial Seed Data & Citations

Issue 4.2 (Epic 4). Records exactly where every price in `supabase/seed.sql`
came from, per this issue's explicit Definition of Done ("source citation
for every price row is part of DoD, not optional").

## Model selection

The PRD deliberately does not name specific OpenAI/Anthropic models — it
only requires supporting the standard call shapes (OpenAI Chat
Completions, Anthropic Messages API — PRD FR-6.7), since pinning exact
model names in a frozen PRD would go stale as providers release new
models. Choosing which models to seed for V1 launch was therefore a
judgment call, made here rather than left undecided.

Selected each provider's current three-tier flagship lineup (fetched
directly from official sources, not third-party pricing aggregators —
several aggregator blogs were checked first and disagreed slightly with
each other and with the providers' own pages, which is exactly why this
issue's DoD requires sourcing from the provider's own published page):

| Provider | Model (API ID) | Tier |
|---|---|---|
| OpenAI | `gpt-5.6-sol` | Flagship |
| OpenAI | `gpt-5.6-terra` | Balanced |
| OpenAI | `gpt-5.6-luna` | Cost-optimized |
| Anthropic | `claude-opus-5` | Flagship |
| Anthropic | `claude-sonnet-5` | Balanced |
| Anthropic | `claude-haiku-4-5-20251001` | Cost-optimized |

## Sources

**OpenAI** — fetched 2026-08-07:
- Model IDs: [developers.openai.com/api/docs/models](https://developers.openai.com/api/docs/models)
- Prices: [openai.com/api/pricing](https://openai.com/api/pricing) (cross-checked against the model-catalog page above — both list identical per-token prices)

| Model | Input $/1M tok | Output $/1M tok |
|---|---|---|
| gpt-5.6-sol | $5.00 | $30.00 |
| gpt-5.6-terra | $2.00 | $12.00 |
| gpt-5.6-luna | $0.20 | $1.20 |

**Anthropic** — fetched 2026-08-07:
- Model IDs: [platform.claude.com/docs/en/about-claude/models/overview](https://platform.claude.com/docs/en/about-claude/models/overview)
- Prices: [platform.claude.com/docs/en/about-claude/pricing](https://platform.claude.com/docs/en/about-claude/pricing)

| Model | Input $/MTok | Output $/MTok | Effective |
|---|---|---|---|
| claude-opus-5 | $5 | $25 | now |
| claude-sonnet-5 | $2 | $10 | now, through 2026-08-31 (introductory) |
| claude-sonnet-5 | $3 | $15 | from 2026-09-01 (standard, already published) |
| claude-haiku-4-5-20251001 | $1 | $5 | now |

## Notes on specific model IDs

- **Haiku 4.5** predates Anthropic's dateless model-ID convention
  (introduced with the 4.6 generation) — its real, pinned API model ID is
  `claude-haiku-4-5-20251001`, even though the human-facing alias is the
  dateless `claude-haiku-4-5`. Seeded using the pinned ID, since that's
  what actually appears in a live API response's `model` field.
- **Opus 5 and Sonnet 5** use the newer dateless convention, where the
  API ID and alias are the same string (`claude-opus-5`,
  `claude-sonnet-5`) — no ambiguity there.
- **OpenAI's `gpt-5.6-sol`** also has a shorter alias (`gpt-5.6`), per its
  model-catalog page — seeded using the full model ID for the same reason
  as Haiku above.

## A caveat worth flagging for whoever builds the SDK (Epic 9/10)

`price_table.model` needs to exactly match whatever string each
provider's API actually returns in a real response's `model` field, since
that's what `LLMCallEvent.model` will be populated with at ingestion time
(cost resolution, issue 4.4, looks up by exact provider+model match). The
IDs above are believed correct based on each provider's own current
documentation, but this is worth a direct spot-check against a real API
response when the Python/Node SDKs are built, in case either provider's
actual runtime response format differs subtly from what their docs show.

## Re-seeding

`supabase/seed.sql` runs automatically on `supabase db reset` for local
development. It was also applied directly to the hosted project
(`qesyrjgrjjaswsrbitdw`) via the same idempotent SQL — safe to re-run at
any time; existing `(provider, model, version)` rows are left untouched.
