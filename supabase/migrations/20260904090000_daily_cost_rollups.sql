-- Issue 8.0 (Epic 8): DailyCostRollup table + indexes + RLS
-- PRD §7 DailyCostRollup -- the pre-aggregated daily summary table every
-- dashboard query in §5.2-§5.4 reads from instead of scanning raw
-- LLMCallEvent rows for any complete historical day (NFR §10.1:
-- dashboard screens "must render initial data within 2 seconds ...
-- relying on DailyCostRollup rather than raw-event scans for any range
-- beyond the current partial day"). Populated by the daily rollup job
-- (issue 8.1+), never written to directly by any user-facing path --
-- same write-path posture as price_table/llm_call_events.
--
-- Same text+CHECK provider convention as llm_call_events/price_table
-- (issues 5.1/4.1), for consistency with the rest of this schema.
--
-- Grain, per PRD §7: "(project, date, provider, model, customer_id,
-- feature_id) -- this supports every dashboard query in §5.2-§5.4
-- without scanning raw LLMCallEvent rows for any complete historical
-- day." customer_id/feature_id are nullable -- issue 8.2's own AC
-- requires "untagged events are included in the aggregation, not
-- dropped", so a rollup row must be able to exist for the untagged
-- case too.
--
-- Judgment call, flagged: a plain `unique (project_id, date, provider,
-- model, customer_id, feature_id)` constraint would NOT actually
-- enforce the grain when customer_id/feature_id are null -- Postgres
-- treats every NULL as distinct from every other NULL for uniqueness
-- purposes, so two untagged rows for the same (project, date, provider,
-- model) would both be allowed to exist side by side. That would break
-- issue 8.3's "idempotent upsert" requirement for the (very common)
-- untagged case: a second run would insert a second row instead of
-- updating the first. Fixed with two generated columns
-- (customer_id_key/feature_id_key) that collapse null to '' so the
-- UNIQUE constraint below actually collapses duplicate untagged rows
-- the same way it does tagged ones. '' can never collide with a real
-- tag value -- PRD's tag fields are developer-supplied, non-empty
-- strings (see ingestion-event-payload.ts's `.min(1)` validation on
-- customer_id/feature_id, issue 6.3), so '' is safely reserved as the
-- "no tag" sentinel here.
--
-- Aggregate columns default to 0 (not null) -- unlike
-- llm_call_events.computed_cost_usd (nullable by design, issue 5.3),
-- a DailyCostRollup row only ever exists because issue 8.2's
-- aggregation query found at least one matching LLMCallEvent for that
-- grain, so its totals are always real computed sums, never "unknown".

create table if not exists public.daily_cost_rollups (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  date date not null,
  provider text not null check (provider in ('openai', 'anthropic')),
  model text not null,
  customer_id text,
  feature_id text,
  total_cost_usd numeric not null default 0 check (total_cost_usd >= 0),
  total_input_tokens bigint not null default 0 check (total_input_tokens >= 0),
  total_output_tokens bigint not null default 0 check (total_output_tokens >= 0),
  call_count integer not null default 0 check (call_count >= 0),
  -- See header comment: collapses null to '' so the grain's uniqueness
  -- constraint (below) actually holds for untagged rows too. Not part
  -- of PRD §7's literal field list -- an implementation-only column,
  -- deliberately never exposed to any dashboard query (those read
  -- customer_id/feature_id directly).
  customer_id_key text generated always as (coalesce(customer_id, '')) stored,
  feature_id_key text generated always as (coalesce(feature_id, '')) stored
);

-- The grain itself, per PRD §7 -- also gives issue 8.3's upsert a real
-- ON CONFLICT target (`on conflict (project_id, date, provider, model,
-- customer_id_key, feature_id_key)`).
alter table public.daily_cost_rollups
  add constraint daily_cost_rollups_grain_key
  unique (project_id, date, provider, model, customer_id_key, feature_id_key);

-- AC2: composite indexes supporting the dashboard query patterns in PRD
-- §5.2-§5.4 without a full table scan. The grain's own UNIQUE
-- constraint above already creates a covering index for
-- (project_id, date, provider, model, ...), which serves §5.2's
-- provider/model breakdown; these two mirror llm_call_events' existing
-- indexing convention (issue 5.1) for §5.3/§5.4's by-feature/by-
-- customer views, which filter on (project_id, date range, tag)
-- without necessarily knowing provider/model up front.
create index if not exists daily_cost_rollups_project_date_feature_idx
  on public.daily_cost_rollups (project_id, date, feature_id);
create index if not exists daily_cost_rollups_project_date_customer_idx
  on public.daily_cost_rollups (project_id, date, customer_id);

-- Judgment call, flagged: issue 8.0's own AC list only names the
-- migration + composite index, but every other table in this schema
-- (3.1, 3.2, 4.1, 5.1, 7.4 -- see docs/RLS.md) gets RLS enabled with a
-- project-scoped SELECT policy as this project's own established,
-- non-negotiable baseline for "a new table exists" -- not something
-- each issue re-states. Applying that same posture here rather than
-- treating its absence from 8.0's AC list as license to skip it. No
-- INSERT/UPDATE/DELETE policy for authenticated/anon -- the rollup job
-- (issue 8.1+) writes via service_role, which bypasses RLS entirely,
-- same as every other backend-written table in this project.
alter table public.daily_cost_rollups enable row level security;

create policy "Users can select own organization daily cost rollups"
  on public.daily_cost_rollups
  for select
  using (
    exists (
      select 1
      from public.projects p
      where p.id = daily_cost_rollups.project_id
        and p.organization_id = private.current_user_organization_id()
    )
  );
