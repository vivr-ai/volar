-- Issue 7.3 (Epic 7): worker-side RPC wrappers -- the two callable
-- surfaces apps/proxy's queue worker (src/worker.ts) actually uses to
-- consume the queue provisioned in issue 7.1 and fed in issue 7.2.
--
-- Same reasoning as issue 7.2's public.enqueue_ingestion_event(): the
-- `pgmq` schema isn't exposed to PostgREST/supabase-js by default, so
-- the worker needs its own narrow, single-purpose `public` wrappers
-- rather than a generic passthrough to pgmq's full surface.
--
-- Two functions, matching the worker's two operations:
--   - dequeue_ingestion_events(vt, qty): wraps pgmq.read() -- claims up
--     to `qty` messages with a `vt`-second visibility timeout (the
--     message becomes invisible to any other reader/worker instance
--     until that timeout elapses, whether or not this call ever
--     finishes processing them).
--   - archive_ingestion_event(msg_id): wraps pgmq.archive() -- called
--     only after a message's row has actually been inserted into
--     llm_call_events. Archiving (not deleting) moves the row into
--     pgmq.a_ingestion_events rather than discarding it outright, which
--     keeps a permanent, queryable record of what this queue has ever
--     carried -- cheap insurance for a system whose job is tracking
--     money, and standard pgmq practice for exactly this reason.
--
-- Never archiving a message that failed to process is the whole retry
-- mechanism for this issue's AC2 ("worker restarts cleanly and resumes
-- without losing in-flight messages"): a message that was read but not
-- archived simply becomes visible again once its `vt` elapses, so a
-- crashed or restarted worker (or a second worker instance) picks it
-- back up automatically -- no separate "resume" logic needs to exist.
-- (A message that fails *repeatedly* forever, rather than transiently,
-- is issue 7.4's dead-letter-after-N-attempts problem, not this one's
-- -- pgmq's own `read_ct` on each envelope, already returned by
-- dequeue_ingestion_events below, is what a future 7.4 would key off
-- of.)
--
-- SECURITY DEFINER + explicit search_path, then immediately locked down
-- to service_role only, revoked from PUBLIC *and* explicitly from
-- anon/authenticated in the same migration -- issue 7.2's own migration
-- history (`enqueue_ingestion_event_wrapper_lockdown.sql`) already
-- proved live that `revoke ... from public` alone does not touch a
-- grant this Supabase project's default-privilege rule gives directly
-- to `anon`/`authenticated` at function-creation time. Applying that
-- lesson up front here (not as a follow-up fix discovered after the
-- fact) -- verified live below regardless, since "I already know the
-- fix" is not the same guarantee as "I checked."

create or replace function public.dequeue_ingestion_events(
  visibility_timeout_seconds integer,
  batch_size integer
)
returns table (
  msg_id bigint,
  read_ct integer,
  enqueued_at timestamptz,
  vt timestamptz,
  message jsonb,
  headers jsonb
)
language sql
security definer
set search_path = pg_catalog, pgmq
as $$
  select msg_id, read_ct, enqueued_at, vt, message, headers
  from pgmq.read('ingestion_events', visibility_timeout_seconds, batch_size, null);
$$;

create or replace function public.archive_ingestion_event(target_msg_id bigint)
returns boolean
language sql
security definer
set search_path = pg_catalog, pgmq
as $$
  select pgmq.archive('ingestion_events', target_msg_id);
$$;

revoke all on function public.dequeue_ingestion_events(integer, integer) from public;
revoke execute on function public.dequeue_ingestion_events(integer, integer) from anon, authenticated;
grant execute on function public.dequeue_ingestion_events(integer, integer) to service_role;

revoke all on function public.archive_ingestion_event(bigint) from public;
revoke execute on function public.archive_ingestion_event(bigint) from anon, authenticated;
grant execute on function public.archive_ingestion_event(bigint) to service_role;
