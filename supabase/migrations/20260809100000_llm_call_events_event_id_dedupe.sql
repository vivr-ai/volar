-- Issue 5.4 (Epic 5): idempotency -- dedupe-by-event-UUID.
--
-- Not one of the fields itemized in PRD §7's LLMCallEvent table (same
-- status as PriceTable in issue 4.1: an elaboration required by the
-- backlog's own explicit scope, not new product scope). SDKs retry
-- failed/ambiguous network requests (PRD NFR §10.2's reliability goals
-- assume this), so without a dedupe key, a single real LLM call could
-- be recorded -- and cost-counted -- more than once whenever a retry
-- happens after the original request actually succeeded server-side.
--
-- `event_id` is generated client-side (by the SDK, once per real LLM
-- call, before any network attempt) and resent unchanged on every retry
-- of that same call. `id` (the table's own PK) intentionally stays a
-- server-generated uuid, unrelated to this -- `event_id` is the
-- caller's idempotency key, not a replacement primary key.
--
-- Global uniqueness (not scoped per-project) is deliberate: a
-- client-generated uuid has 122 bits of randomness, so cross-project
-- collision risk is negligible, and a single global unique index is
-- simpler than a composite (project_id, event_id) one with no real
-- safety benefit here.
--
-- The table has zero rows in production as of this migration (V1
-- hasn't shipped), so a straight NOT NULL add is safe -- no backfill
-- needed.

alter table public.llm_call_events
  add column event_id uuid not null;

alter table public.llm_call_events
  add constraint llm_call_events_event_id_key unique (event_id);
