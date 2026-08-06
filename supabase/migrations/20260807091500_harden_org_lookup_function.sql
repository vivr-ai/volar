-- Issue 2.2 follow-up: the Supabase security advisor flagged
-- public.current_user_organization_id() as callable directly via
-- PostgREST (/rest/v1/rpc/current_user_organization_id) by both anon and
-- authenticated roles, since Postgres grants EXECUTE on public-schema
-- functions to PUBLIC by default. It's only ever meant to be used inside
-- RLS policy definitions, not called directly by clients.
--
-- Fix: move it into a "private" schema, which PostgREST never exposes
-- (only schemas explicitly listed in Supabase's API settings are
-- reachable via /rest/v1/...), and grant EXECUTE only to `authenticated`
-- (required, since RLS policies run with the invoking role's privileges).
-- This removes the function from the API surface entirely while leaving
-- RLS enforcement itself unaffected. See docs/RLS.md for the full
-- writeup and the isolation test re-run after this change.

create schema if not exists private;

create or replace function private.current_user_organization_id()
returns uuid
language sql
security definer
set search_path = ''
stable
as $$
  select organization_id from public.users where id = auth.uid();
$$;

grant usage on schema private to authenticated;
grant execute on function private.current_user_organization_id() to authenticated;

alter policy "Users can select own organization" on public.organizations
  using (id = private.current_user_organization_id());

alter policy "Users can select own organization members" on public.users
  using (organization_id = private.current_user_organization_id());

drop function public.current_user_organization_id();
