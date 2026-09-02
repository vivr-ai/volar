-- Issue 7.1 (Epic 7): grant apps/proxy's service_role client actual
-- access to the pgmq schema/queue created in the prior migration.
--
-- Verified live (not assumed) that this was missing: installing the
-- pgmq extension alone grants EXECUTE on its functions broadly, but
-- NOT `USAGE` on the `pgmq` schema itself -- and calling a
-- schema-qualified function still requires schema USAGE to resolve
-- it, regardless of a direct EXECUTE grant on the function. Confirmed
-- via `set role service_role; select pgmq.send(...)` failing with
-- "permission denied for schema pgmq" before this migration.
--
-- anon/authenticated deliberately get nothing here, same
-- default-deny posture as every other table in this project (see
-- docs/RLS.md) -- customers never touch the queue directly, only the
-- proxy's service_role client does (mirroring `api_keys.hashed_key`'s
-- column-level restriction: only the one trusted server-side identity
-- can reach this).
--
-- `alter default privileges` covers any *future* queue this project
-- creates via `pgmq.create(...)` (e.g. a dead-letter queue in a later
-- Epic 7 issue) without needing another grants migration each time.

grant usage on schema pgmq to service_role;
grant all on all tables in schema pgmq to service_role;
grant all on all functions in schema pgmq to service_role;
grant all on all sequences in schema pgmq to service_role;

alter default privileges in schema pgmq
  grant all on tables to service_role;
alter default privileges in schema pgmq
  grant all on functions to service_role;
alter default privileges in schema pgmq
  grant all on sequences to service_role;
