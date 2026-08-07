# Auth Configuration — Supabase

Issue 2.1 (Epic 2). Records how Supabase Auth is configured for the Volar
project (ref `qesyrjgrjjaswsrbitdw`), per PRD §US-1.1 (AC1: sign-up via
Supabase Auth, email/password or magic link, no credit card required).

This is dashboard configuration, not code — nothing in this repo reads
these settings directly, but they gate what `supabase-js` calls succeed
from `apps/dashboard` once the sign-up UI is built (later Epic 2 issues).

## Providers enabled

- **Email** — Supabase's single Email provider covers both password
  sign-up and magic link (passwordless OTP) sign-in; there is no separate
  toggle for magic link. Enabled by default, confirmed on in
  `Authentication → Providers`.

## URL Configuration

Set in `Authentication → URL Configuration`:

| Field | Value |
|---|---|
| Site URL | `https://volar-dashboard-phi.vercel.app` |
| Redirect URLs | `http://localhost:3000/**` |
| | `https://volar-dashboard-phi.vercel.app/**` |
| | `https://volar-dashboard-*.vercel.app/**` |

The wildcard entry covers Vercel's per-PR preview deployments (issue
1.7), which each get a unique generated subdomain — a single wildcard
pattern avoids having to add a new exact URL for every PR.

## Verification (issue 2.1 AC3)

No sign-up UI exists yet, so both flows were verified directly against
the Auth REST API using the project's publishable (anon) key:

- `POST /auth/v1/signup` with email + password → returned a full user
  object with `provider: "email"`.
- `POST /auth/v1/otp` with just an email → returned `{}` (success; email
  sent).

Both test users are visible in `Authentication → Users` in the Supabase
dashboard. These are throwaway test accounts and can be deleted at any
time without affecting anything else.

## Sign-up auto-provisioning (issue 2.3)

A Postgres trigger (`private.handle_new_auth_user()`, fired by
`on_auth_user_created after insert on auth.users`) runs immediately after
every successful sign-up and creates, in the same transaction:

1. An `organizations` row — name defaults to `"<email-local-part>'s
   Organization"` (no org-name field is collected at sign-up, per the
   PRD's zero-friction design; this default is a judgment call, easy to
   change later).
2. A `public.users` profile row (same id as the `auth.users` row).
3. A default `projects` row named `"Default Project"`.

**Atomicity:** no exception handling wraps these inserts, so a failure in
any of them rolls back the entire transaction, including the `auth.users`
row itself — there is no state where an Organization exists without its
User/Project, or vice versa.

**Idempotency:** the function returns immediately, doing nothing, if a
`public.users` row already exists for that auth id — a duplicate trigger
firing for the same user can never create a second Organization.

**Hardening:** the function initially lived in `public` and was flagged
by Supabase's security advisor as reachable via
`/rest/v1/rpc/handle_new_auth_user` (Postgres grants EXECUTE on
public-schema functions to PUBLIC by default). Moved to the `private`
schema (introduced in issue 2.2's own hardening fix) — trigger firing
doesn't require the inserting role to hold EXECUTE on the function, so
this has no effect on the trigger itself, only on removing it from the
API surface.

**Verified** with two real sign-ups (one before, one after the hardening
move) — in both cases exactly one Organization, one User, and one
Project ("Default Project") were created, correctly linked.
