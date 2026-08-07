# Row Level Security — Organizations, Users, Projects & API Keys

Issues 2.2 (Epic 2), 3.1, and 3.2 (Epic 3). Documents the RLS design for
`public.organizations`, `public.users`, `public.projects`, and
`public.api_keys`, and the isolation test that must be re-run before
every future migration touching these tables (per issue 2.2's explicit
Definition of Done,
which this project extends the same discipline to).

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
