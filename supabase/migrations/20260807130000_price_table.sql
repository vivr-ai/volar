-- Issue 4.1 (Epic 4): PriceTable schema
-- PRD §7 PriceTable ("implied by Blueprint's 'maintained, versioned
-- price table'... required to satisfy FR-6.5 and FR-8.1"); PRD §8
-- FR-8.1 (deterministic cost computation only) / FR-8.2 (append-only
-- versioning — price changes are new rows, never edits to past rows, so
-- historical costs stay correct against what was actually charged at the
-- time).
--
-- Unlike every table so far, this is global reference data, not scoped
-- to an Organization or Project — published provider pricing is the same
-- for every customer. No tenant boundary to enforce, so RLS here is
-- simply "any signed-in user can read, nobody but elevated/internal
-- tooling can write" rather than the organization-scoped pattern used
-- elsewhere (see docs/RLS.md).
--
-- Naming: kept singular (`price_table`) rather than pluralized like
-- every other table in this schema (organizations, users, projects,
-- api_keys, customer_tags, feature_tags) — deliberate, since this reads
-- more naturally as "the price table" (one conceptual versioned
-- dataset) than as a collection of distinct price tables.

create table if not exists public.price_table (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('openai', 'anthropic')),
  model text not null,
  effective_from timestamptz not null,
  input_price_per_1k_tokens_usd numeric not null check (input_price_per_1k_tokens_usd >= 0),
  output_price_per_1k_tokens_usd numeric not null check (output_price_per_1k_tokens_usd >= 0),
  version integer not null check (version >= 1),
  source text not null,
  unique (provider, model, version)
);

-- Supports issue 4.4's "resolve the correct PriceTable version in effect
-- at a given occurred_at timestamp" lookup.
create index if not exists price_table_lookup_idx
  on public.price_table (provider, model, effective_from);

alter table public.price_table enable row level security;

create policy "Any authenticated user can read the price table"
  on public.price_table
  for select
  to authenticated
  using (true);

-- No INSERT/UPDATE/DELETE policy for authenticated/anon — enabling RLS
-- with only a SELECT policy denies writes entirely for those roles by
-- default. Issue 4.5's internal CLI (for adding new price versions) is
-- expected to run with elevated (service_role or direct database)
-- credentials, outside the app, not as an authenticated dashboard user.
