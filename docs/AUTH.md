# Auth Configuration — Supabase

Issue 2.1 (Epic 2). Records how Supabase Auth is configured for the Volar
project (ref `qesyrjgrjjaswsrbitdw`), per PRD §US-1.1 (AC1: sign-up via
Supabase Auth, email/password or magic link, no credit card required).

This is dashboard configuration, not code — nothing in this repo reads
these settings directly, but they gate what `supabase-js` calls succeed
from `apps/dashboard` once the sign-up UI is built (later Epic 2 issues).

## Dashboard integration (issue 2.4)

`apps/dashboard` now has real Supabase client wiring:

- `lib/supabase/client.ts` — browser client, for Client Components.
- `lib/supabase/server.ts` — server client, for Server Components/Actions/
  Route Handlers. Created fresh per request (never cached in module
  scope).
- `lib/supabase/proxy.ts` — `updateSession()`, called on every request to
  refresh the session and redirect unauthenticated requests to `/app/*`
  routes to `/sign-in`.
- `proxy.ts` (app root) — Next.js 16's request-boundary file (renamed
  from `middleware.ts` in Next 16; same concept, runs on the Node.js
  runtime). Wires `updateSession()` into every request except static
  assets.

Route protection always uses `supabase.auth.getClaims()`, never
`getSession()` — `getClaims()` validates the JWT signature against the
project's published keys on every call, which is what makes it safe to
trust in server-side route protection; `getSession()` does not
revalidate and can be spoofed.

Reads `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` (see
`apps/dashboard/.env.example`). For local dev, `apps/dashboard/.env.local`
already has the real (non-secret, browser-safe) values — copied from the
same project referenced throughout this file. Vercel needs the same two
variables added for both Preview and Production under Project Settings →
Environment Variables — that's a manual dashboard step, same as the rest
of Vercel's configuration in this repo.

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

## Account Settings page (issue 2.5)

`apps/dashboard/app/app/account/` — a minimal page at `/app/account` for
changing password and email, using only default Supabase Auth SDK
methods (PRD §US-5.3 AC1: "no custom requirements beyond default
Supabase Auth flows"). This is the Epic 2 (Platform/Backend) version;
Epic 16 rebuilds it into the fully designed "Account / API Key
Management" screen on the same route.

- **Password change** re-authenticates via `signInWithPassword()` before
  calling `updateUser({ password })` — Supabase's `updateUser()` doesn't
  check the current password on its own (it trusts the active session),
  so this extra step is what produces a real "current password is
  incorrect" error, while still only using standard SDK methods.
- **Email change** calls `updateUser({ email })` directly. Supabase's
  default "secure email change" behavior requires confirming the change
  via email before it takes effect, satisfying AC2 as-is — no extra code
  needed.
- **Known limitation:** a magic-link-only user (never set a password)
  will always see "current password is incorrect" when attempting a
  password change, since there's nothing for `signInWithPassword` to
  verify. Acceptable for this minimal page; Epic 16.5 is a reasonable
  place to detect auth provider and adjust the form.
