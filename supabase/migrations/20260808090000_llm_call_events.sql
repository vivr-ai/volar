-- Issue 5.1 (Epic 5): LLMCallEvent table + indexes + RLS
-- PRD §7 LLMCallEvent — the core ingested event table this entire
-- product measures cost from. Scoped by Project (not directly by
-- Organization) since API keys are issued per-Project (issue 3.2) and
-- an ingested event always carries the project_id resolved from the
-- API key used to send it.
--
-- provider/status use the same text+CHECK style as price_table (issue
-- 4.1) rather than a native Postgres ENUM type, for consistency and to
-- avoid ALTER TYPE friction if a third provider is ever added.
--
-- computed_cost_usd is nullable by design (not just "optional") --
-- issue 5.3 requires the write path to store null (with an internal
-- alert) rather than fail the whole insert when no PriceTable entry
-- resolves for a given provider/model. A null cost must be
-- distinguishable from a real $0 cost, so no default and no NOT NULL
-- here.
--
-- Write path: this table is written exclusively by apps/proxy's
-- ingestion code (issue 5.2+) using the Supabase service_role key
-- (see docs/SECRETS.md), which bypasses RLS entirely -- the same
-- pattern already used for price_table. No INSERT/UPDATE/DELETE policy
-- exists for `authenticated`/`anon` here; enabling RLS with only a
-- SELECT policy denies writes to those roles by default.

create table if not exists public.llm_call_events (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  provider text not null check (provider in ('openai', 'anthropic')),
  model text not null,
  input_tokens integer not null check (input_tokens >= 0),
  output_tokens integer not null check (output_tokens >= 0),
  computed_cost_usd numeric check (computed_cost_usd >= 0),
  customer_id text,
  feature_id text,
  occurred_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  status text not null check (status in ('success', 'error'))
);

-- Supports the dashboard query patterns in PRD §5.2-§5.4 and this
-- issue's explicit AC2.
create index if not exists llm_call_events_project_occurred_at_idx
  on public.llm_call_events (project_id, occurred_at);
create index if not exists llm_call_events_project_feature_id_idx
  on public.llm_call_events (project_id, feature_id);
create index if not exists llm_call_events_project_customer_id_idx
  on public.llm_call_events (project_id, customer_id);

alter table public.llm_call_events enable row level security;

create policy "Users can select own organization llm call events"
  on public.llm_call_events
  for select
  using (
    exists (
      select 1
      from public.projects p
      where p.id = llm_call_events.project_id
        and p.organization_id = private.current_user_organization_id()
    )
  );
