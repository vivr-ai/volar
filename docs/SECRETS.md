# Secrets & Environment Variables — Convention & Runbook

Issue 1.9 (Epic 1). Establishes how every secret in the Volar stack is
stored, injected, and rotated across Vercel (dashboard), Railway (proxy),
and local development. This is the parent reference — each app's
`.env.example` lists only the variables that specific app reads.

## The rule

Real secret values live in exactly one of two places, never a third:

1. **The platform's own secret store** — Vercel's Environment Variables
   UI, Railway's Variables tab. This is the source of truth for
   staging/production.
2. **A local, gitignored `.env` / `.env.local` file** — for your own
   machine only, copied from the relevant `.env.example`.

Real values are never committed to the repo, never pasted into a commit
message, PR description, or Slack/email. `.env.example` files contain
variable *names* and, where harmless, format hints — never real values,
not even old/rotated ones.

## Where each secret lives today

| Secret | Used by | Stored in | Status |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | dashboard | Vercel (Preview + Production) | Reserved for Epic 2 |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | dashboard | Vercel (Preview + Production) | Reserved for Epic 2 |
| `NEXT_PUBLIC_SENTRY_DSN` | dashboard | Vercel (Preview + Production) | Reserved for issue 19.1 |
| `SUPABASE_URL` | proxy | Railway (staging + production) | Reserved for Epic 5/6 |
| `SUPABASE_SERVICE_ROLE_KEY` | proxy | Railway (staging + production) | Reserved for Epic 5/6 — **never** give this to the dashboard; it bypasses RLS entirely |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | `packages/internal-cli` (issue 4.5) | Local-only `.env`, never deployed to any platform | Live — used only when a team member runs the price-table CLI by hand |
| `SENTRY_DSN` | proxy | Railway (staging + production) | Reserved for issue 19.2 |
| `AXIOM_TOKEN` | proxy | Railway (staging + production) | Reserved for issue 19.3 |
| `ANTHROPIC_API_KEY` | proxy (tentative — see note in `apps/proxy/.env.example`) | Railway (staging + production) | Reserved for Epic 18 |

"Reserved" means the variable name is agreed and documented now so a
later issue doesn't have to invent a naming convention under time
pressure — none of these are read by any code yet as of issue 1.9.

**Update (issue 7.1):** the `UPSTASH_REDIS_REST_URL` / `_TOKEN` row this
section originally reserved is gone, not just renamed — the ingestion
queue ended up built on Supabase's `pgmq` extension instead of Upstash
(see `supabase/migrations/20260902071700_ingestion_queue_pgmq.sql` for
the full reasoning), so it's reached through the existing
`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` pair above rather than a
secret of its own. This is the one place this doc's original table
turned out to reserve a name for something that, once actually built,
needed no new secret at all.

Note one deliberate asymmetry: staging and production get **separate**
values for every secret above (separate Supabase project or at minimum
separate keys, as those pieces come online) — never share a production
credential into staging. The queue is the one exception as of issue
7.1: Volar currently runs a single shared Supabase project for both
Railway environments (true for every other Supabase-backed piece of
this stack already, not a new gap introduced here), so "staging" and
"production" both reach the *same* `pgmq.q_ingestion_events` queue for
now. Revisit if/when this project ever splits into genuinely separate
staging/production Supabase projects.

## Rotating a secret

General steps, same shape for any of the above:

1. Generate the new value at the source (Supabase dashboard, Upstash
   console, Sentry project settings, Anthropic console, etc.).
2. Set the new value in the platform store (Vercel or Railway) for
   **both** staging/preview and production — do this before revoking
   the old one, so there's no downtime gap.
3. Redeploy the affected service so the new value is actually picked up
   (Vercel/Railway both redeploy automatically on a variable change; if
   not, trigger manually).
4. Revoke/delete the old value at the source once the redeploy is
   confirmed healthy.
5. If the secret was ever suspected to have leaked (e.g., briefly
   committed, pasted somewhere insecure), treat step 4 as immediate and
   non-optional, and check the CI secret-scan history (see below) for
   when it might have first appeared.

Specific notes:
- **`SUPABASE_SERVICE_ROLE_KEY`**: Supabase Dashboard → Project Settings
  → API → reset the service role key. This invalidates the old key
  instantly — steps 2–3 above must happen in the same sitting, not
  spread across a day.
- **Anthropic/other provider keys**: rotating does not affect historical
  data (PriceTable versioning, per PRD §8 FR-8.2, is what makes past
  cost figures stable — unrelated to which API key is currently active).

## Preventing accidental commits

`.github/workflows/secret-scan.yml` runs Gitleaks (MIT-licensed, run as
a plain binary rather than the marketplace Action to avoid that action's
per-seat licensing on private repos) against every PR. A detected secret
pattern fails the check and blocks that PR from looking "green" — this
is the enforcement mechanism for this issue's Definition of Done ("the
secret-scan CI step must be green").

If the scanner ever flags a false positive (e.g., a test fixture that
looks like a key), fix it by making the fixture obviously fake (e.g.
`sk-test-not-a-real-key-000...`) rather than suppressing the scanner —
per this issue's Definition of Done, this check does not get bypassed.
