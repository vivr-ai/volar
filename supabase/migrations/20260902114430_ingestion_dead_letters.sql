-- Issue 7.4 (Epic 7): dead-letter table for events that fail processing
-- repeatedly, so a poison-pill message stops retrying forever (the
-- accepted-but-flagged-as-inefficient state issue 7.3 deliberately left
-- in place, per that issue's own header comment) and instead becomes a
-- queryable, inspectable record instead.
--
-- Deliberately a plain table, not another pgmq queue -- the backlog's
-- own AC2 only asks for something "visible/queryable for the team
-- (even just a DB table is sufficient for V1)", and a plain public
-- table is both simpler than provisioning a second pgmq queue for this
-- and directly queryable via the Supabase SQL editor/dashboard without
-- any new tooling.
--
-- Deliberately loose/unconstrained columns (no FK to projects, no NOT
-- NULL on event_id/project_id, message stored as raw jsonb with no
-- shape check): the entire point of this table is to reliably capture
-- data that has *already* proven malformed or otherwise unprocessable.
-- A strict schema here risks the dead-letter insert itself failing on
-- exactly the kind of broken input it exists to catch -- which would
-- violate this issue's own AC3 ("no event is ever silently discarded
-- without a trace"). event_id/project_id are still pulled out into
-- their own columns (best-effort, whatever the raw message happened to
-- contain) purely so the team can filter/search without having to
-- reach into the jsonb column for the common cases.
--
-- RLS: enabled, no policies added -- same default-deny posture as every
-- other table in this project (see docs/RLS.md). Nothing customer-
-- facing reads this table in V1 (no PRD/backlog item asks for a
-- dashboard view of failed events yet); only the worker's service_role
-- client ever writes to it, and service_role bypasses RLS entirely, so
-- "visible/queryable for the team" for V1 means direct DB access (the
-- Supabase SQL editor/dashboard), not a customer-facing UI -- revisit
-- if a future issue asks for one.

create table public.ingestion_dead_letters (
  id uuid primary key default gen_random_uuid(),
  -- pgmq's own message id -- lets the team cross-reference this row
  -- against pgmq.a_ingestion_events (this message was archived, not
  -- deleted, when it was dead-lettered -- see worker code comments).
  msg_id bigint not null,
  event_id text,
  project_id text,
  -- The exact raw payload the worker last saw, unmodified -- the
  -- ground truth for whatever was wrong with it.
  message jsonb not null,
  -- 'invalid' (failed re-validation, see queue-message.ts's schema) or
  -- 'failed' (validation passed but the write itself threw) -- mirrors
  -- process-queue-message.ts's ProcessMessageOutcome discriminant.
  failure_reason text not null,
  error_detail text,
  -- pgmq's own read_ct at the moment this row was written -- "N
  -- attempts" per this issue's AC1, not a separately-tracked counter.
  attempts integer not null,
  enqueued_at timestamptz not null,
  dead_lettered_at timestamptz not null default now()
);

create index ingestion_dead_letters_dead_lettered_at_idx
  on public.ingestion_dead_letters (dead_lettered_at desc);
create index ingestion_dead_letters_project_id_idx
  on public.ingestion_dead_letters (project_id);

alter table public.ingestion_dead_letters enable row level security;

comment on table public.ingestion_dead_letters is
  'Issue 7.4: events that failed queue processing at or beyond the worker''s max-attempts threshold. Written by apps/proxy''s worker (service_role) via a direct table insert -- no RPC wrapper needed, unlike pgmq access, since this is a plain public-schema table. See docs/RLS.md''s "Dead-letter table (issue 7.4)" section.';
