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
