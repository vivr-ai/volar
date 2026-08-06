# Row Level Security — Organizations & Users

Issue 2.2 (Epic 2). Documents the RLS design for `public.organizations`
and `public.users`, and the isolation test that must be re-run before
every future migration touching these tables (per this issue's explicit
Definition of Done).

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
