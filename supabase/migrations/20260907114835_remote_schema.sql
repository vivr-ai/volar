-- Migration unit 1: schema_changes
-- Transaction mode: transactional
-- Boundary reason: default

DROP EXTENSION pg_net;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT DELETE, INSERT, SELECT, UPDATE ON TABLES TO anon;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT, USAGE ON SEQUENCES TO anon;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON ROUTINES TO anon;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT DELETE, INSERT, SELECT, UPDATE ON TABLES TO authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT, USAGE ON SEQUENCES TO authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON ROUTINES TO authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT DELETE, INSERT, SELECT, UPDATE ON TABLES TO service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT, USAGE ON SEQUENCES TO service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON ROUTINES TO service_role;

GRANT DELETE, INSERT, UPDATE ON public.api_keys TO anon;

GRANT DELETE, INSERT, UPDATE ON public.api_keys TO authenticated;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.api_keys TO service_role;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.customer_tags TO anon;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.customer_tags TO authenticated;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.customer_tags TO service_role;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.daily_cost_rollups TO anon;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.daily_cost_rollups TO authenticated;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.daily_cost_rollups TO service_role;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.feature_tags TO anon;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.feature_tags TO authenticated;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.feature_tags TO service_role;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.ingestion_dead_letters TO anon;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.ingestion_dead_letters TO authenticated;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.ingestion_dead_letters TO service_role;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.llm_call_events TO anon;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.llm_call_events TO authenticated;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.llm_call_events TO service_role;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.organizations TO anon;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.organizations TO authenticated;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.organizations TO service_role;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.price_table TO anon;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.price_table TO authenticated;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.price_table TO service_role;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.projects TO anon;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.projects TO authenticated;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.projects TO service_role;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.users TO anon;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.users TO authenticated;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.users TO service_role;
