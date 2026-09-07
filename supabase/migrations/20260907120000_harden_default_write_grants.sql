-- Ad hoc security hardening, found while closing issue 8.0 -- not tied
-- to a specific backlog issue, disclosed per the Working Agreement
-- rather than silently patched.
--
-- `supabase db pull` (run for the first time in this project today)
-- generated a diff (20260907114835_remote_schema.sql) revealing that
-- this Supabase project carries a project-creation-time default-
-- privilege rule granting `anon`/`authenticated` broad table-level
-- INSERT/UPDATE/DELETE (and ALL on routines) on every object created
-- in `public`, including every table this project has ever migrated.
--
-- This is the same root-cause class of gap already found and fixed
-- twice before -- issue 3.4's `upsert_customer_tag`/`upsert_feature_tag`
-- functions, and issue 7.2's `enqueue_ingestion_event` -- but both of
-- those fixes only revoked access from the one function already
-- created at the time. Neither touched the underlying DEFAULT PRIVILEGE
-- rule itself, so the next new function or table created after those
-- fixes would silently reopen the same gap -- which is exactly what
-- happened again today: this issue's own `daily_cost_rollups` table
-- (migration 20260904090000) picked up the same broad grants
-- automatically at creation time, same as every table before it.
--
-- Why this was never caught by any live RLS test in docs/RLS.md: every
-- positive/negative check in this project tests RLS's *policy* layer
-- (has a row-level policy been correctly written), not the *grant*
-- layer underneath it (can this role even attempt the operation before
-- RLS is evaluated at all). RLS's default-deny (a table with RLS
-- enabled and zero write policies denies writes regardless of grants)
-- has been doing 100% of the real protective work this whole time --
-- correctly, per every "violates row-level security policy" error
-- already documented -- but that means protection has had exactly one
-- layer, not two. If a future migration ever added a write policy more
-- broadly than intended, or RLS were ever accidentally left disabled on
-- a new table, there would be no second, independent layer of table
-- grants to catch it.
--
-- This migration is revoke-only and changes no legitimate behavior:
-- SELECT is deliberately left untouched on every table (every read
-- path in this app relies on anon/authenticated being able to attempt
-- a SELECT at all, with RLS policies doing the actual row filtering --
-- see docs/RLS.md), and no table in this schema has an INSERT/UPDATE/
-- DELETE policy for anon/authenticated at all -- every write in this
-- codebase happens via service_role (docs/SECRETS.md), which this
-- migration does not touch. Sequences are deliberately left alone too
-- -- this schema has no serial/bigserial-backed columns for
-- anon/authenticated to meaningfully exploit via sequence USAGE/SELECT,
-- so touching that surface adds risk without a corresponding threat
-- here; revisit only if a future table actually introduces one.

-- 1. Fix the actual root cause: stop the default-privilege rule itself
-- from granting write access on tables, or any access on routines, to
-- anon/authenticated for anything created from this point forward.
alter default privileges for role postgres in schema public
  revoke insert, update, delete on tables from anon, authenticated;

alter default privileges for role postgres in schema public
  revoke all on routines from anon, authenticated;

-- 2. Close the gap for every table that already exists today.
revoke insert, update, delete on all tables in schema public from anon, authenticated;

-- 3. Same sweep for any function already reachable via the old default
-- rule and not yet individually locked down the way
-- enqueue_ingestion_event / dequeue_ingestion_events /
-- archive_ingestion_event / upsert_customer_tag / upsert_feature_tag
-- already were -- this is a reinforcing no-op for those five, and
-- closes the gap for anything else.
revoke all on all functions in schema public from anon, authenticated;
