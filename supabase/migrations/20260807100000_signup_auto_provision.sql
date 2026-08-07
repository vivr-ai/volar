-- Issue 2.3 (Epic 2): sign-up flow — auto-create Organization + User +
-- default Project on first successful auth.
-- PRD §US-1.1 AC1: an Organization, a default Project, and a User record
-- are created with no billing fields required, atomically.
--
-- No org-name field is collected at sign-up (zero-friction flow, PRD
-- §US-1.1 non-goals list no team-invite/plan-selection step, and by
-- extension no org-naming step) — defaults to a name derived from the
-- email's local part. This is a judgment call, easy to change later since
-- nothing else depends on the literal string.
--
-- Atomicity (AC2): this function runs inside the same transaction as the
-- triggering INSERT on auth.users, with no exception handling that would
-- swallow an error. If any insert below fails, the whole transaction
-- (including the auth.users row itself) rolls back — there is no
-- partially-provisioned state possible.
--
-- Idempotency (AC3): if a public.users row already exists for this auth
-- id, the function returns immediately without creating a second
-- Organization/Project.
--
-- NOTE: this function was moved from public to private in the follow-up
-- migration 20260807101500_harden_signup_trigger_function.sql (same
-- rationale as 2.2's harden_org_lookup_function). Kept here unmodified
-- for an accurate history; see that file and docs/AUTH.md for the final
-- state.

create or replace function public.handle_new_auth_user()
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
  execute function public.handle_new_auth_user();
