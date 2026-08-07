# @volar/internal-cli

Internal (non-customer-facing) tooling for the Volar team. Not part of the
product surface shipped to customers — never imported by `apps/dashboard`
or `apps/proxy`.

## Runbook: adding a new PriceTable version

**When to run this:** a provider (OpenAI or Anthropic) changes their
published per-token pricing for a model we already track, or we add
support for a new model.

**Why this exists:** per `Volar_V1_PRD.md` §8 FR-8.2, price changes are
always a new versioned row in `price_table` — we never edit or delete a
past row. That's what keeps historical cost figures (issue 4.3's
`computeCostUsd`, resolved via issue 4.4's `resolvePriceForEvent`)
correct against what a customer's calls actually cost at the time they
were made, even after the price changes later. This CLI is the only
sanctioned way to write to `price_table` outside of a migration/seed —
it exists so no one is ever tempted to hand-edit a price row in the
Supabase dashboard.

### Steps

1. Confirm the new price on the provider's own published pricing page
   (not a third-party aggregator) and note the exact URL and the date you
   checked it — you'll want this for the `--source` note.
2. Get `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` for the target
   project (Supabase Dashboard → Project Settings → API). Copy
   `.env.example` in this package to `.env` and fill them in. **Never**
   commit this file or paste the service role key anywhere outside your
   local `.env`.
3. Run a dry run first to confirm exactly what will be inserted:
   ```bash
   pnpm --filter @volar/internal-cli run add-price-version -- \
     --provider anthropic \
     --model claude-sonnet-5 \
     --effective-from 2026-09-01T00:00:00Z \
     --input-price 0.0030 \
     --output-price 0.0150 \
     --source "https://platform.claude.com/docs/en/about-claude/pricing (checked 2026-08-07)" \
     --dry-run
   ```
   `--effective-from` should be the exact instant the provider's new
   price takes effect (issue 4.4's lookup treats this boundary as
   inclusive). Version numbers are chosen automatically (one past the
   highest existing version for that provider/model) unless you pass an
   explicit `--version`.
4. If the printed row looks correct, re-run the exact same command
   without `--dry-run`. The tool prints the inserted row's `id` and
   `version` on success.
5. Spot-check in Supabase Studio (or via SQL) that the old version's row
   is untouched and the new row has the version you expected.
6. Update `docs/PRICE_TABLE.md`'s citation table with the new row's
   source URL and fetch date, matching the pattern already used there
   for the initial seed (issue 4.2).

### Safety behavior

- Refuses to run without `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` set
  (this tool intentionally requires the service role key — `price_table`
  grants no INSERT policy to regular `authenticated` users, see issue
  4.1's migration).
- Refuses an explicit `--version` that already exists for that
  provider/model, with a clear error listing the existing versions — it
  will never silently overwrite one. The database's own
  `unique (provider, model, version)` constraint is a second, independent
  backstop if this check is ever bypassed.
- Never issues an UPDATE or DELETE against `price_table` — only INSERT.

### Local testing

```bash
pnpm --filter @volar/internal-cli run typecheck
pnpm --filter @volar/internal-cli run test
```

The test suite covers argument validation and version-resolution logic
only (pure functions, no network access) — it does not touch a real
database. See `docs/RLS.md` and this issue's closing commit notes for
the direct-against-the-database verification (positive insert, duplicate
rejection, and append-only check) performed once against the real
project as part of closing this issue.

Linked from the future launch docs in issues 24.2/24.3 once those exist.
