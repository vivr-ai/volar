# Row Level Security — Organizations, Users, Projects, API Keys, Tags, PriceTable & LLMCallEvent

Issues 2.2 (Epic 2), 3.1, 3.2, 3.4 (Epic 3), 4.1 (Epic 4), and 5.1
(Epic 5). Documents the RLS design for `public.organizations`,
`public.users`, `public.projects`, `public.api_keys`,
`public.customer_tags`, `public.feature_tags`, `public.price_table`, and
`public.llm_call_events`, and the isolation test that must be re-run
before every future migration touching these tables (per issue 2.2's
explicit Definition of Done, which this project extends the same
discipline to).

## Tables

- `public.organizations` — PRD §7 Organization.
- `public.users` — PRD §7 User. `id` is the same uuid as the
  corresponding `auth.users.id` row (shared PK, not a separate FK
  column) — this is Supabase Auth's user, extended with our own
  `organization_id`, `email` (denormalized copy), and `last_login_at`.

Both tables have RLS enabled. Enabling RLS denies every operation by
default for any role except the table owner; only two SELECT policies
exist so far — INSERT/UPDATE/DELETE by `authenticated` remain fully
denied until a later issue explicitly needs them (e.g. issue 2.5's
account settings, issue 2.3's sign-up trigger — the latter runs as a
SECURITY DEFINER function owned by the table owner, so it is unaffected
by this restriction).

## The `private.current_user_organization_id()` helper

Both SELECT policies need to compare a row's `organization_id` against
"the calling user's own organization_id" — which itself requires a
lookup in `public.users`. Doing that lookup inline in the `users` table's
own policy would query the same table the policy protects, which is a
recursion trap. The standard fix (and what's used here) is a
`SECURITY DEFINER` SQL function: it runs with the function owner's
privileges, bypassing RLS internally, so the lookup succeeds without
re-triggering the policy it's used inside.

First version of this function lived in `public` and was flagged by
Supabase's security advisor (`get_advisors`) as callable directly by
external clients via `/rest/v1/rpc/current_user_organization_id` —
Postgres grants `EXECUTE` on `public`-schema functions to `PUBLIC` by
default, and PostgREST exposes anything in an API-exposed schema as an
RPC endpoint. A follow-up migration
(`20260807091500_harden_org_lookup_function.sql`) moved it to a new
`private` schema instead, which PostgREST never exposes regardless of
grants, and granted `EXECUTE` only to `authenticated` (required, since
RLS policies evaluate with the invoking role's privileges — revoking it
entirely would break the policies for real logged-in users). This
removes it from the API surface while leaving enforcement unchanged.

## Isolation test (re-run before any future migration touching these tables)

Two real Supabase Auth users already existed from issue 2.1's manual
sign-up test (`vivekr300+testpw@gmail.com`,
`vivekr300+magiclink@gmail.com`). Each was seeded into a separate test
organization:

| User | Org |
|---|---|
| `20bfc07b-ceba-41a8-a74b-875c212999ca` (testpw) | `11111111-1111-1111-1111-111111111111` ("RLS Test Org A") |
| `4af51618-ef8c-4f1e-8af8-ce817f658a3e` (magiclink) | `22222222-2222-2222-2222-222222222222` ("RLS Test Org B") |

Test procedure — simulate each user's session directly in SQL (this is
the standard way to test RLS without a real client, per Supabase's own
docs on locally testing policies):

```sql
set local role authenticated;
set local request.jwt.claim.sub = '<user-id>';
set local request.jwt.claim.role = 'authenticated';

select * from public.organizations;
select * from public.users;
```

**Result:** as User A, both queries returned exactly one row each — Org A
and User A. As User B, exactly one row each — Org B and User B. Neither
user's session could see the other organization's row in either table.
Confirmed again after the `private`-schema hardening fix, with the same
result. This satisfies issue 2.2's AC2.

The two test orgs/users are harmless fixtures and can be deleted at any
time; they aren't referenced by anything else.

## Projects (issue 3.1)

`public.projects` follows the identical pattern: RLS enabled, one SELECT
policy scoped via the same `private.current_user_organization_id()`
helper, no INSERT/UPDATE/DELETE policy yet (the sign-up trigger in issue
2.3 creates the default Project as a SECURITY DEFINER operation, so it's
unaffected).

Isolation re-test, same two test users, one project seeded per org:

| Project | Org |
|---|---|
| `33333333-3333-3333-3333-333333333333` ("RLS Test Project A") | Org A |
| `44444444-4444-4444-4444-444444444444` ("RLS Test Project B") | Org B |

As User A, `select * from public.projects` returned only Project A. As
User B, only Project B. Confirmed via the same role-simulation procedure
above. `get_advisors` (security) came back clean apart from the
pre-existing, unrelated "leaked password protection disabled" Auth
warning (not part of this issue's scope).

## API Keys (issue 3.2)

`public.api_keys` has no `organization_id` column of its own — it scopes
through `project_id`, so its SELECT policy joins to `public.projects`
instead of comparing a column directly:

```sql
using (
  exists (
    select 1 from public.projects p
    where p.id = api_keys.project_id
      and p.organization_id = private.current_user_organization_id()
  )
)
```

This is safe from recursion (it queries a different table, not itself),
and `projects`' own RLS policy still applies to this subquery when run
as `authenticated`, so the two layers agree rather than conflict.

**Column-level restriction (AC2):** RLS controls which *rows* a role can
see, not which *columns* — so hiding `hashed_key` from any future
client-facing query needed a separate mechanism: `authenticated` and
`anon` had `SELECT` fully revoked on `api_keys`, then re-granted only for
the non-secret columns (`id`, `project_id`, `key_prefix`, `created_at`,
`last_used_at`, `revoked_at`, `rotated_from_key_id`). Verified directly —
`select hashed_key from public.api_keys` as `authenticated` returns
`permission denied for table api_keys`, not just an empty/filtered
result. Whatever eventually verifies a presented key against its hash
(issue 3.3, called from the proxy service) runs with elevated
`service_role` privileges, which bypass this restriction entirely, so
real key verification is unaffected.

The actual hash format stored in `hashed_key` is
`<16-byte hex salt>:<sha256 hex digest of salt+key>`, produced by
`packages/shared`'s `hashApiKey()` (issue 3.3) — see that file's code
comments for why salted SHA-256 rather than bcrypt is the right choice
for a high-entropy random token like this, as opposed to a human-chosen
password.

Isolation re-test, one key seeded per org's project:

| Key | Project | Org |
|---|---|---|
| `55555555-5555-5555-5555-555555555555` (`vlr_live_aaaa`) | Project A | Org A |
| `66666666-6666-6666-6666-666666666666` (`vlr_live_bbbb`) | Project B | Org B |

As User A, only Project A's key was visible. `get_advisors` clean apart
from the same pre-existing, unrelated Auth warning.

**Deliberately not enforced here:** PRD §7 notes "one active key per
Project," but that's left to application logic (issues 3.3/6.2/16.2),
not a DB constraint — the 24-hour rotation grace period (US-5.1 AC2)
requires the old and new key to both validate simultaneously for a day,
which a strict "one non-revoked key" uniqueness constraint would break.

### Auth middleware verification (issue 6.2)

`apps/proxy`'s API-key auth middleware (`authenticateApiKey` /
`evaluateApiKeyCandidates` in `src/auth/authenticate-api-key.ts`) has its
own fixture-driven unit tests, but per this project's testing discipline
its DB-facing adapter (`src/auth/supabase-api-key-repository.ts`) was
also verified directly against this live project rather than assumed
correct from the unit tests alone. Six disposable rows were seeded under
the existing "RLS Test Project A" (`33333333-...`), covering every
branch: an active key, a revoked key, an old key rotated <24h ago
(should still authenticate), and an old key rotated >24h ago (should
not). The repository's exact two queries (`select ... where key_prefix
= $1`, then `select ... where rotated_from_key_id in (...)`) were run
directly, and the results were fed through the same decision logic used
in production (Node, not just reasoned about) — all six produced the
expected outcome, including the two cases proving AC4 (a totally unknown
prefix and a known prefix with the wrong secret both return the exact
same `not_found` outcome — no distinguishable signal for a prober).
`get_advisors` came back clean apart from the same pre-existing,
unrelated Auth warning noted throughout this doc. All six disposable
rows were deleted after verification. A negative check (`authenticated`
selecting `hashed_key`) was re-run too, reconfirming issue 3.2's
column-privilege restriction still holds — `permission denied for table
api_keys`, unchanged.

### last_used_at update verification (issue 6.6)

`api_keys.last_used_at` (nullable `timestamptz`, no default) already
existed in the issue 3.2 migration — this issue only added the write
path, so verification focused on confirming the exact UPDATE the new
adapter (`createTouchApiKeyLastUsedAt` in
`src/auth/supabase-api-key-repository.ts`) runs actually works under
`service_role`, since `public.api_keys` only has a `SELECT` RLS policy
("Users can select own organization api keys") — no `UPDATE` policy
exists for `authenticated`/`anon` at all. Seeded one disposable row
under Project A (`33333333-...`, id `66666666-...-666666660601`) with
`last_used_at` explicitly `null`; ran `update api_keys set
last_used_at = now() where id = $1` (the same statement the adapter
issues); confirmed the column changed from `null` to a real timestamp;
deleted the row. `service_role` bypasses RLS entirely regardless of the
missing `UPDATE` policy for `public` — same behavior already
established and re-confirmed for every other write in this file.

## Customer & Feature Tags (issue 3.4)

`public.customer_tags` and `public.feature_tags` are lookup tables
populated automatically the first time a given tag string is seen on an
ingested event — not user-created. Same organization-scoped SELECT
policy pattern as `api_keys` (join through `project_id` to `projects`).

Two SQL functions do the actual upsert — `upsert_customer_tag(project_id,
external_id)` and `upsert_feature_tag(project_id, external_id)`. Both are
idempotent by design: `first_seen_at` is set only by the initial insert
and never touched by the `ON CONFLICT` branch; `last_seen_at` updates on
every call. Verified directly: calling the same function twice (in two
separate transactions, a few seconds apart) left exactly one row, with
`first_seen_at` unchanged and `last_seen_at` advanced.

**A real mistake, caught by testing rather than assumed away:** the
original migration tried to restrict these backend-only functions to
`service_role` with `revoke execute on function ... from public;` —
mirroring the grant-restriction idea, but using the wrong target. This
did nothing: Supabase's default privileges grant EXECUTE to the *named*
roles `anon`, `authenticated`, and `service_role` directly (via `ALTER
DEFAULT PRIVILEGES`), not to the generic `PUBLIC` pseudo-role — revoking
"from public" only touches a grant made to that pseudo-role. I only
caught this because I tested the restriction directly (calling the
function as `authenticated` after applying it) rather than assuming the
migration succeeded because it ran without error. It returned a result
instead of a permission error, which is what caught the bug. Fixed in a
follow-up migration, `20260807121500_fix_tag_upsert_grants.sql`, revoking
from `anon, authenticated` by name — re-verified afterward with the same
live test, which now correctly fails with `permission denied for
function upsert_customer_tag`.

This is worth remembering for any future function-level grant
restriction in this project: **always revoke from the specific named
roles (`anon`, `authenticated`), never rely on `revoke ... from
public`.**

## PriceTable (issue 4.1)

`public.price_table` is the first table that departs from the
organization-scoped pattern entirely — it's global reference data (the
same published provider pricing for every customer), not scoped to an
Organization or Project. RLS is still enabled (consistent with every
other table here), but the policy is simply "any signed-in user can
read":

```sql
create policy "Any authenticated user can read the price table"
  on public.price_table
  for select
  to authenticated
  using (true);
```

No INSERT/UPDATE/DELETE policy exists, so those remain denied for
`authenticated`/`anon` by default — writes are expected to come from
issue 4.5's internal CLI, run with elevated credentials outside the app.

Verified directly (not assumed, per the 3.4 lesson above): as
`authenticated`, `select` against a seeded test row succeeded, and a
follow-up `insert` attempt correctly failed with `new row violates
row-level security policy for table "price_table"`. The
`(provider, model, version)` unique constraint was also verified
directly — a duplicate insert failed with `duplicate key value violates
unique constraint "price_table_provider_model_version_key"`.
`get_advisors` clean apart from the same pre-existing, unrelated Auth
warning.

## LLMCallEvent (issue 5.1)

`public.llm_call_events` is the core ingested-event table (PRD §7) —
every dashboard number in V1 is ultimately derived from these rows.
Scoped by `project_id` (not a direct `organization_id` column), same
join-through-`projects` SELECT policy pattern as `api_keys` and the
tag tables:

```sql
using (
  exists (
    select 1 from public.projects p
    where p.id = llm_call_events.project_id
      and p.organization_id = private.current_user_organization_id()
  )
)
```

No INSERT/UPDATE/DELETE policy exists for `authenticated`/`anon` — this
table is written exclusively by `apps/proxy`'s ingestion code (issue
5.2+), using the `SUPABASE_SERVICE_ROLE_KEY` reserved for the proxy
since issue 1.9, which bypasses RLS entirely rather than going through
a SECURITY DEFINER function. This mirrors `price_table`'s write path.

`computed_cost_usd` is nullable by design, not just optional — issue
5.3 requires a null cost (with an internal alert) rather than a failed
insert when no PriceTable entry resolves for a given provider/model. A
`check (computed_cost_usd >= 0)` still guards against a negative value
whenever it is present.

Isolation re-test, one event seeded per org's existing test project
(33333333.../Org A, 44444444.../Org B):

As User A, `select project_id, provider, model, customer_id from
public.llm_call_events` returned only Org A's event
(`project_id = 33333333-...`, `customer_id = 'cust-a'`) — Org B's row
never appeared. As User B, only Org B's event appeared. A follow-up
`insert` as `authenticated` (User A, into User A's own project)
correctly failed with `new row violates row-level security policy for
table "llm_call_events"`, confirming writes are denied entirely for
that role, not just filtered. `get_advisors` clean apart from the same
pre-existing, unrelated Auth warning. Both disposable test rows were
deleted after verification.

### event_id dedupe column (issue 5.4)

A follow-up migration added `event_id uuid not null unique` — a
client-generated idempotency key (not part of PRD §7's original field
list, same "elaboration required by the backlog" status as
`price_table`), so an SDK's retried delivery of the same real LLM call
never creates a second row or double-counts a future DailyCostRollup.
Global uniqueness (not scoped per-project) is deliberate — see the
migration file's comment for the reasoning. Verified directly: a plain
duplicate `insert` fails with `duplicate key value violates unique
constraint "llm_call_events_event_id_key"` (the DB-level backstop, AC2),
while `insert ... on conflict (event_id) do nothing` — what the
application code actually uses — silently no-ops, leaving exactly one
row. `get_advisors` clean apart from the same pre-existing, unrelated
Auth warning.

## Ingestion queue — `pgmq` (issue 7.1)

The `pgmq` extension (Supabase's own "Queues" product) lives in its own
`pgmq` schema, outside `public` — same default-deny posture as
everything else in this document. Installing the extension alone does
**not** grant the proxy's `service_role` client anything: a follow-up
grants migration was required after a live test proved this (see
below), which is exactly the kind of gap this project's testing
discipline exists to catch before it reaches production, not after.

Verified directly, in this order:

1. After the first migration (`create extension pgmq;` +
   `pgmq.create('ingestion_events')`) alone: `set role service_role;
   select pgmq.send('ingestion_events', ...)` failed with `permission
   denied for schema pgmq` — confirming the gap rather than assuming
   the extension's default grants were sufficient.
2. After the grants migration (`grant usage on schema pgmq to
   service_role` + `grant all ... to service_role` on existing and,
   via `alter default privileges`, future tables/functions/sequences):
   the same `pgmq.send(...)` call as `service_role` succeeded, returning
   a real `msg_id`.
3. Full manual enqueue → dequeue cycle as `service_role` (AC3 of issue
   7.1): `pgmq.send()` enqueued a test message; `pgmq.read()` retrieved
   it with a visibility timeout (the "a worker is looking at this,
   don't hand it to anyone else yet" read pattern); `pgmq.pop()`
   (read-and-delete-atomically) removed it once the timeout had
   elapsed. `select count(*) from pgmq.q_ingestion_events` returned `0`
   afterward — queue left empty, not carrying a stray verification
   message into real use.
4. Negative check: `set role anon; select pgmq.send(...)` failed with
   the same `permission denied for schema pgmq` — confirming the
   default-deny posture holds for the one role this queue must never be
   reachable from directly (customers only ever reach it indirectly,
   through `POST /v1/events`, once issue 7.2 wires that up).

`get_advisors` clean apart from the same pre-existing, unrelated Auth
warning noted throughout this document.

## Ingestion queue enqueue wrapper (issue 7.2)

PostgREST (what `supabase-js`'s `.from()`/`.rpc()` calls actually talk
to) only exposes the `public`/`graphql_public` schemas by default — the
proxy's Supabase client has no direct way to call `pgmq.send()` in the
`pgmq` schema issue 7.1 provisioned. Issue 7.2 adds a `SECURITY DEFINER`
wrapper function, `public.enqueue_ingestion_event(payload jsonb)`, that
calls `pgmq.send('ingestion_events', payload)` on the caller's behalf
and returns the resulting `msg_id`. `SECURITY DEFINER` functions run
with the *owner's* privileges regardless of caller — the standard,
Supabase-documented pattern for reaching a non-`public` schema from
PostgREST — but that also means the function's own grants are the only
thing standing between `service_role` and every other role that can
reach PostgREST at all, so this needed the same live-verified,
not-assumed treatment as issue 7.1's schema grants.

Verified directly, in this order:

1. After the first migration (`create function
   public.enqueue_ingestion_event(...)` + `revoke all ... from public;
   grant execute ... to service_role;`): `set role service_role; select
   public.enqueue_ingestion_event('{"eventId": "..."}'::jsonb);`
   succeeded, returning a real `msg_id` (confirmed via `select * from
   pgmq.q_ingestion_events` showing the message, then purged).
2. Negative check, same migration state: `set role anon; select
   public.enqueue_ingestion_event(...)` **succeeded** — msg_id 3 — when
   it should have failed. A real gap, caught live before merge, not
   assumed away. Root cause, confirmed via
   `information_schema.role_routine_grants`: this Supabase project
   carries a default-privilege rule (set at project creation, before any
   of this project's own migrations) that grants `EXECUTE` on every new
   `public`-schema function directly to `anon`/`authenticated`.
   `revoke ... from public` only revokes the pseudo-role's own grant —
   it does not touch a privilege granted directly to a *named* role, so
   `anon`/`authenticated` kept their independent grant regardless. This
   is the exact same class of gap this project already hit once for a
   table's grants (see `fix_tag_upsert_grants`, issue 3.4's follow-up
   migration) — now confirmed to apply to `public`-schema *functions*
   too, not just tables.
3. Follow-up migration: `revoke execute on function
   public.enqueue_ingestion_event(jsonb) from anon, authenticated;`.
   Re-verified: `set role anon` and `set role authenticated` against the
   same call both now fail with `permission denied for function
   enqueue_ingestion_event`; `set role service_role` still succeeds.

All four SQL-level checks above were run directly against the live
project, then `pgmq.purge_queue('ingestion_events')` was used to clear
the disposable test messages afterward, leaving the queue empty rather
than carrying stray verification data into real use. `createSupabaseEnqueueEvent()`
(the actual TypeScript adapter apps/proxy calls, via `.rpc()`) is
covered by this codebase's usual dependency-injected unit tests against
an in-memory fake (see `../apps/proxy/src/routes/events.test.ts`'s
"enqueueing onto the ingestion queue (issue 7.2)" describe block) —
those tests do not themselves touch the network. A real-network,
skip-by-default live test for that exact adapter function now exists
too (`supabase-queue-repository.live.test.ts`, matching the precedent
set by `write-llm-call-event.live.test.ts` for the write path), but
actually running it requires the real `SUPABASE_SERVICE_ROLE_KEY`
secret value, which this tool's Supabase access does not expose (the
`get_publishable_keys` tool only ever returns the anon/publishable key,
by design) — same constraint flagged for the Railway deploy gap. It's
ready for Vivek or a future team member with that secret to run
manually; the raw-SQL checks above are what stand in for it for now.

`get_advisors` clean apart from the same pre-existing, unrelated Auth
warning noted throughout this document.

## Worker RPC wrappers — dequeue/archive (issue 7.3)

Same PostgREST-doesn't-expose-`pgmq` reasoning as issue 7.2's
`enqueue_ingestion_event`, applied to the worker's two operations: two
more narrow `public`-schema `SECURITY DEFINER` wrappers,
`public.dequeue_ingestion_events(vt, qty)` (wraps `pgmq.read()`) and
`public.archive_ingestion_event(msg_id)` (wraps `pgmq.archive()`).

Unlike issue 7.2, the `anon`/`authenticated` lockdown was written into
the *same* migration as the functions themselves this time, applying
the lesson issue 7.2 learned live rather than repeating the same gap.
Verified live regardless, not assumed correct just because "we already
know the fix":

1. `set role anon; select * from public.dequeue_ingestion_events(30, 5);`
   — failed immediately with `permission denied for function
   dequeue_ingestion_events`.
2. `set role authenticated;` against the same call — failed the same
   way.
3. `reset role; select public.enqueue_ingestion_event(...)` (issue
   7.2's function, to seed a real message) — succeeded, `msg_id 6`.
4. `select * from public.dequeue_ingestion_events(30, 5);` as
   `service_role` — succeeded, returned the seeded message with
   `read_ct: 1` and the exact jsonb payload intact.
5. `select public.archive_ingestion_event(6);` as `service_role` —
   succeeded (`true`); `select count(*) from pgmq.q_ingestion_events`
   immediately after — `0`, confirming the message actually left the
   live queue (moved to `pgmq.a_ingestion_events`, not deleted outright
   — see the migration's own comment for why archiving over deleting
   was chosen for this project).

`get_advisors` clean apart from the same pre-existing, unrelated Auth
warning noted throughout this document.

The worker's own read-insert-archive cycle (the actual TypeScript code
path, not just the raw RPCs) is covered by `run-worker-cycle.test.ts` /
`run-worker-loop.test.ts` (in-memory fakes) and by
`worker-cycle.live.test.ts` (issue 7.3 AC3's literal stated test —
"enqueue a message, assert a row appears" — skip-gated the same way as
`supabase-queue-repository.live.test.ts`, for the same
service-role-secret-access reason noted above).

## Dead-letter table (issue 7.4)

`public.ingestion_dead_letters` (this issue's own migration) is a plain
table, not a `pgmq`-schema object — no RPC wrapper needed the way
enqueue/dequeue/archive needed one; the worker's `service_role` client
writes to it via a direct `.from(...).insert(...)` call, same as every
other plain-table write in this project. RLS is enabled with **no
policies** — the same default-deny-everything posture as every other
table in this document, deliberately with nothing carved out yet for
`authenticated`/`anon` since no V1 PRD/backlog item asks for a
customer-facing view of dead-lettered events.

Verified directly, in this order:

1. `set role anon;` then attempting an insert — failed with `new row
   violates row-level security policy for table "ingestion_dead_letters"`.
   (A plain `select count(*)` as `anon` did *not* error — it succeeded
   and returned `0`, which is the correct outcome via a different
   mechanism: `anon` apparently has a table-level SELECT grant from the
   same kind of project-wide default-privilege rule seen in issues 7.2/
   7.3, but RLS with zero policies filters every row regardless, so the
   net result — `anon` can see none of this table's data — holds either
   way. Confirmed this doesn't extend to writing: the INSERT attempt
   above was denied outright.)
2. `set role authenticated;` — the same insert attempt failed the same
   way.
3. `reset role;` (`service_role`) — the same insert succeeded, and a
   follow-up `select` confirmed the row's columns matched exactly what
   was written; the probe row was then deleted, leaving the table
   empty.

`get_advisors` reports one new, expected, informational item —
`rls_enabled_no_policy` for `public.ingestion_dead_letters` — which is
exactly the intended state (RLS on, no policies, default-deny), not a
gap; noted here so it isn't mistaken for an oversight on a future pass.
Otherwise clean apart from the same pre-existing, unrelated Auth
warning noted throughout this document.

The dead-letter *decision* logic (when a repeatedly-failing message
actually gets moved here, keyed off pgmq's own per-message `read_ct`)
is pure and covered entirely by fast in-memory unit tests
(`dead-letter.test.ts`, and the "dead-lettering (issue 7.4)" describe
block in `run-worker-cycle.test.ts`) rather than a live test that waits
through several real visibility-timeout cycles — see
`supabase-dead-letter-repository.live.test.ts`'s header comment for why
that split was chosen, matching the precedent set for the enqueue/
dequeue RPC paths.

## Load test fixtures (issue 7.5)

Issue 7.5's burst-traffic load test needs real organizations/projects/
API keys that the live auth middleware (issue 6.2) will actually
accept — synthetic in-memory fixtures don't exercise the deployed
staging environment the way this issue requires.

**A real course-correction, not a silent decision:** the first attempt
at this (mid-way through this issue, before `src/load-test/` existed)
seeded one *persistent* "Load Test Org" with 10 real projects and 10
real API keys directly via SQL, intending to commit their plaintext
into this repo so the load-test script could reuse the same keys on
every run. On reflection that was wrong, for two reasons: it would have
put a long-lived, genuinely working credential into git history
indefinitely (this project's own operating rules treat API keys,
tokens, and passwords as things Claude must never enter into a
field/file/commit, and a committed plaintext key is exactly that risk
realized), and it broke from this document's own established
convention — every fixture recorded above (RLS Test Org A/B, the 3.2/
6.2/6.6 disposable API-key rows, the 5.1 LLMCallEvent rows) is
explicitly disposable, deleted immediately after the verification that
needed it, not kept around as a standing credential. That first
attempt's seed data (1 organization, 10 projects, 10 API keys) was
deleted from this live project before any of it was committed — nothing
from it ever reached git.

**What actually shipped instead:** `apps/proxy/src/load-test/provision-fixtures.ts`
self-provisions a fresh organization + N projects + N API keys at the
start of every load-test run (`generateApiKey()`/`hashApiKey()` from
`packages/shared`, the exact same functions the real signup path would
use), and tears all of it down again once the run finishes — success or
failure, via a `try/finally` in the CLI entrypoint. Every run's
plaintext keys exist only in that run's process memory; none are ever
written to disk, logged, or committed. This matches the disposable-
fixture convention above, just automated instead of manual, since this
fixture (unlike the one-off RLS isolation tests) needs to be recreated
on every future run rather than seeded once.

The one thing that *is* persistent is the naming convention:
organizations are named `Load Test Org (issue 7.5) <ISO timestamp>` and
projects `Load Test Project <index>`, so any load-test-run debris left
behind by a crashed run (teardown not reached) is easy to identify and
hand-delete — `delete from public.organizations where name like 'Load
Test Org%'` cascades through the same FK chain teardownLoadTestFixtures
itself uses.
