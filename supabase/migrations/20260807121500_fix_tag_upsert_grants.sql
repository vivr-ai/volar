-- Issue 3.4 correction: my original migration ran
-- `revoke execute on function ... from public;`, but this is a no-op
-- against Supabase's setup — Supabase's default privileges grant EXECUTE
-- to the named roles `anon`, `authenticated`, and `service_role`
-- directly (via ALTER DEFAULT PRIVILEGES), not via the special PUBLIC
-- pseudo-role. Revoking "from public" only removes a grant made to that
-- pseudo-role, so it did nothing here — verified by inspecting
-- pg_proc.proacl, which still showed anon=X and authenticated=X after
-- the original migration, and confirmed with a live test: `authenticated`
-- could still call upsert_customer_tag successfully. Fixing by revoking
-- from the actual named roles this time.

revoke execute on function public.upsert_customer_tag(uuid, text) from anon, authenticated;
revoke execute on function public.upsert_feature_tag(uuid, text) from anon, authenticated;
