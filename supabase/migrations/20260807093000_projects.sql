-- Issue 3.1 (Epic 3): Project table + RLS
-- PRD §7 "Data Model — Required Entities": Project, scoped to Organization.
--
-- Same RLS pattern as issue 2.2 (organizations/users): enabling RLS denies
-- every operation by default except for the table owner; only a SELECT
-- policy is added here, scoped via the private.current_user_organization_id()
-- helper introduced in 2.2's follow-up migration. INSERT (the sign-up
-- trigger, issue 2.3, creates the default Project) runs as a SECURITY
-- DEFINER function owned by the table owner, so it is unaffected by the
-- lack of an INSERT policy for `authenticated`.

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

create index if not exists projects_organization_id_idx
  on public.projects (organization_id);

alter table public.projects enable row level security;

create policy "Users can select own organization projects"
  on public.projects
  for select
  using (organization_id = private.current_user_organization_id());
