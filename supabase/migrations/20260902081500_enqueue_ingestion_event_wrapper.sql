-- Issue 7.2 (Epic 7): public.enqueue_ingestion_event() -- the one
-- callable surface apps/proxy actually uses to enqueue.
--
-- Why a wrapper, not calling pgmq.send() directly from the app: this
-- project's Supabase client (like every Supabase client) talks to
-- Postgres through PostgREST, which by default only exposes functions
-- in the `public` (and `graphql_public`) schema -- `pgmq` is
-- deliberately not in that exposed list (nothing in this project's
-- migration history has ever changed that default, and widening it
-- would expose pgmq's *entire* surface area, including administrative
-- functions this app has no business calling). A narrow, single-
-- purpose `public` wrapper is Supabase's own documented pattern for
-- reaching an extension schema's functions from a client library.
--
-- SECURITY DEFINER + explicit search_path (never trust an implicit
-- one in a SECURITY DEFINER function -- that's a documented Postgres
-- privilege-escalation footgun) so it can reach `pgmq` regardless of
-- the caller's own grants, then immediately locked back down: revoked
-- from PUBLIC, granted only to service_role -- same default-deny
-- posture as every other sensitive surface in this project (RLS.md).
-- Deliberately narrow (one hardcoded queue name, one jsonb param)
-- rather than a generic "send to any queue" passthrough, so this
-- function can never be used to reach a queue this app doesn't own.
--
-- NOTE: the `revoke ... from public` / `grant ... to service_role`
-- pair below turned out to be insufficient on its own -- see the
-- immediately-following migration
-- (20260902081600_enqueue_ingestion_event_wrapper_lockdown.sql) for
-- why, and don't drop that migration when replaying history; both are
-- required together.

create or replace function public.enqueue_ingestion_event(payload jsonb)
returns bigint
language sql
security definer
set search_path = pg_catalog, pgmq
as $$
  select pgmq.send('ingestion_events', payload);
$$;

revoke all on function public.enqueue_ingestion_event(jsonb) from public;
grant execute on function public.enqueue_ingestion_event(jsonb) to service_role;
