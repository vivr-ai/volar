-- Issue 2.3 follow-up: same fix as 2.2's harden_org_lookup_function —
-- the security advisor flagged public.handle_new_auth_user() as callable
-- directly via PostgREST (/rest/v1/rpc/handle_new_auth_user) by both
-- anon and authenticated roles. It's only ever meant to run as an
-- auth.users trigger, never called directly.
--
-- Fix: move it into the private schema (already created in 2.2's
-- hardening migration), which PostgREST never exposes. Trigger firing
-- does not require the inserting role to hold EXECUTE on the trigger
-- function — Postgres invokes it via the trigger mechanism, not a direct
-- call — so no grants are needed for the trigger itself to keep working.
-- Verified with a real sign-up after this migration: Organization, User,
-- and default Project were still created correctly.

create or replace function private.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_org_name text;
begin
  if exists (select 1 from public.users where id = new.id) then
    return new;
  end if;

  v_org_name := coalesce(split_part(new.email, '@', 1), 'New') || '''s Organization';

  insert into public.organizations (name)
  values (v_org_name)
  returning id into v_org_id;

  insert into public.users (id, organization_id, email)
  values (new.id, v_org_id, new.email);

  insert into public.projects (organization_id, name)
  values (v_org_id, 'Default Project');

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function private.handle_new_auth_user();

drop function if exists public.handle_new_auth_user();
