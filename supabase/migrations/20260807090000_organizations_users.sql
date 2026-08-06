-- Issue 2.2 (Epic 2): Organization + User tables + baseline RLS
-- PRD §7 "Data Model — Required Entities": Organization, User (Volar account holder)
--
-- Naming: PRD uses singular capitalized entity names (Organization, User);
-- this migration uses plural snake_case table names (organizations, users)
-- per standard Postgres/Supabase convention. public.users is distinct from
-- the built-in auth.users (Supabase Auth's own table) — public.users is our
-- application-level profile row, one-to-one with an auth.users row.

create extension if not exists pgcrypto;

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now(),
  -- V1 unused, reserved for V2 Stripe integration per PRD §7
  billing_customer_id text
);

create table if not exists public.users (
  -- Same id as the Supabase Auth user (auth.users.id) — shared PK, not a
  -- separate generated uuid, per PRD §7 "maps to Supabase Auth user id".
  id uuid primary key references auth.users (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  email text not null,
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);

create index if not exists users_organization_id_idx
  on public.users (organization_id);

alter table public.organizations enable row level security;
alter table public.users enable row level security;

-- Looks up the calling user's organization_id. SECURITY DEFINER so this
-- query runs with the function owner's privileges (bypassing RLS) rather
-- than the caller's — this avoids infinite recursion that would occur if
-- the users-table RLS policy queried the users table under its own RLS.
create or replace function public.current_user_organization_id()
returns uuid
language sql
security definer
set search_path = public
stable
as $$
  select organization_id from public.users where id = auth.uid();
$$;

-- Baseline RLS: enabling RLS above already denies every operation by
-- default for any role other than the table owner. The two policies below
-- are the only exception — both are read-only (SELECT), scoped to the
-- caller's own organization. INSERT/UPDATE/DELETE by the authenticated
-- role remain denied entirely for now; the sign-up trigger (issue 2.3)
-- runs as a SECURITY DEFINER function/trigger owned by the table owner,
-- so it is unaffected by this restriction.

create policy "Users can select own organization"
  on public.organizations
  for select
  using (id = public.current_user_organization_id());

create policy "Users can select own organization members"
  on public.users
  for select
  using (organization_id = public.current_user_organization_id());
