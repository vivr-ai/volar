-- Issue 3.4 (Epic 3): CustomerTag + FeatureTag tables + auto-upsert
-- PRD §7 CustomerTag / FeatureTag — lookup/dimension tables populated
-- automatically the first time a given external customer_id/feature_id
-- tag string is seen on an ingested event (not for users to pre-register
-- tags). LLMCallEvent (the table that will actually trigger these
-- upserts) doesn't exist yet (Epic 6) — this issue creates the tables
-- and the upsert functions the future ingestion code will call; whether
-- that ends up being a direct call from the proxy service or a trigger
-- on LLMCallEvent is an Epic 6 decision, not this one.

create table if not exists public.customer_tags (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  external_customer_id text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (project_id, external_customer_id)
);

create table if not exists public.feature_tags (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  external_feature_id text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (project_id, external_feature_id)
);

create index if not exists customer_tags_project_id_idx
  on public.customer_tags (project_id);
create index if not exists feature_tags_project_id_idx
  on public.feature_tags (project_id);

alter table public.customer_tags enable row level security;
alter table public.feature_tags enable row level security;

create policy "Users can select own organization customer tags"
  on public.customer_tags
  for select
  using (
    exists (
      select 1
      from public.projects p
      where p.id = customer_tags.project_id
        and p.organization_id = private.current_user_organization_id()
    )
  );

create policy "Users can select own organization feature tags"
  on public.feature_tags
  for select
  using (
    exists (
      select 1
      from public.projects p
      where p.id = feature_tags.project_id
        and p.organization_id = private.current_user_organization_id()
    )
  );

-- Idempotent upsert: first_seen_at is set only by the initial insert
-- (never touched by the ON CONFLICT branch); last_seen_at updates every
-- time. Calling this any number of times with the same project_id +
-- external id never duplicates a row or errors.
create or replace function public.upsert_customer_tag(
  p_project_id uuid,
  p_external_customer_id text
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.customer_tags (
    project_id, external_customer_id, first_seen_at, last_seen_at
  )
  values (p_project_id, p_external_customer_id, now(), now())
  on conflict (project_id, external_customer_id)
  do update set last_seen_at = excluded.last_seen_at;
$$;

create or replace function public.upsert_feature_tag(
  p_project_id uuid,
  p_external_feature_id text
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.feature_tags (
    project_id, external_feature_id, first_seen_at, last_seen_at
  )
  values (p_project_id, p_external_feature_id, now(), now())
  on conflict (project_id, external_feature_id)
  do update set last_seen_at = excluded.last_seen_at;
$$;

-- Backend-only functions (called by the future ingestion proxy, never by
-- dashboard/browser code) — restrict execution to service_role from the
-- start, rather than leaving the default PUBLIC execute grant in place
-- and waiting for the security advisor to flag it (as happened with
-- 2.2's and 2.3's helper functions).
revoke execute on function public.upsert_customer_tag(uuid, text) from public;
grant execute on function public.upsert_customer_tag(uuid, text) to service_role;

revoke execute on function public.upsert_feature_tag(uuid, text) from public;
grant execute on function public.upsert_feature_tag(uuid, text) to service_role;
