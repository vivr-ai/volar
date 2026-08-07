-- Issue 3.2 (Epic 3): APIKey table + RLS
-- PRD §7 "Data Model — Required Entities": APIKey, scoped to Project.
--
-- "one active key per Project" (PRD §7 note) is a product-level rule, not
-- a DB constraint here — the 24-hour rotation grace period (US-5.1 AC2)
-- requires the old and new key to both be valid simultaneously for a
-- day, so a strict uniqueness constraint on "one non-revoked key" would
-- directly conflict with that. Enforced in rotation logic instead
-- (issues 3.3/6.2/16.2).

create table if not exists public.api_keys (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  key_prefix text not null,
  hashed_key text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  rotated_from_key_id uuid references public.api_keys (id)
);

create index if not exists api_keys_project_id_idx
  on public.api_keys (project_id);

alter table public.api_keys enable row level security;

-- Same organization-scoping pattern as organizations/users/projects, but
-- api_keys has no organization_id column of its own — it scopes through
-- project_id, so the policy joins to projects (whose own RLS policy
-- applies to this subquery too, since it runs as the calling role).
create policy "Users can select own organization api keys"
  on public.api_keys
  for select
  using (
    exists (
      select 1
      from public.projects p
      where p.id = api_keys.project_id
        and p.organization_id = private.current_user_organization_id()
    )
  );

-- AC2: hashed_key must never be exposed via any default `select *` from
-- a client-facing query. RLS only restricts which *rows* a role can see,
-- not which *columns* — so this is enforced separately, at the column
-- privilege level: `authenticated` (and `anon`, denied entirely by RLS
-- anyway, but restricted here too for defense in depth) can only select
-- the columns listed below. hashed_key is deliberately absent. Whatever
-- eventually verifies a presented key against its hash (issue 3.3's
-- utility, called from the proxy service) runs with elevated
-- (service_role) privileges, which bypass this restriction entirely, so
-- this has no effect on real key verification.
revoke select on public.api_keys from authenticated, anon;

grant select (
  id,
  project_id,
  key_prefix,
  created_at,
  last_used_at,
  revoked_at,
  rotated_from_key_id
) on public.api_keys to authenticated, anon;
