# Volar

The margin operating system for AI-native software companies. This monorepo
contains everything needed to build and run **Version 1 (MVP): Cost
Visibility**, per the frozen `Volar_V1_PRD.md` and
`Volar_V1_Engineering_Execution_Plan.md`.

## Workspace structure

This is a single pnpm + Turborepo workspace. Every V1 component lives here
so app, proxy, and SDK code stay coordinated against one shared contract
(the event-payload schema in `packages/shared`).

```
volar/
├── apps/
│   ├── dashboard/      # Next.js + TypeScript + Tailwind customer-facing app
│   │                   # (scaffolded in issue 1.2)
│   └── proxy/          # Standalone Node/TypeScript ingestion service —
│                       # NOT Next.js API routes; needs persistent,
│                       # low-latency behavior (scaffolded in issue 1.3)
├── packages/
│   ├── sdk-python/     # pip-installable `volar` package (issue 9.1+)
│   ├── sdk-node/       # npm-installable `@volar/sdk` package (issue 10.1+)
│   └── shared/         # Shared TS types/schemas used by dashboard + proxy
│                       # (e.g. the ingestion event-payload contract)
├── pnpm-workspace.yaml
├── turbo.json
└── package.json
```

`packages/sdk-python` is not a pnpm workspace member (it's a Python
package, built with its own `pyproject.toml` in issue 9.1) — it lives under
`packages/` purely for folder-structure consistency with the other SDK.

## Prerequisites

- Node.js >= 20
- [pnpm](https://pnpm.io) via Corepack: `corepack enable && corepack prepare pnpm@9 --activate`

## Getting started

```bash
pnpm install   # installs all workspace members from repo root
pnpm dev       # runs `dev` in every app in parallel, via Turborepo
pnpm build     # builds every app/package
pnpm lint      # lints every app/package
pnpm test      # runs every app/package's test suite
```

Each command above fans out to the matching script in every
`apps/*`/`packages/*` package.json via Turborepo. Until issues 1.2/1.3 land,
`dashboard` and `proxy` scripts are placeholders that no-op successfully —
this is expected, and lets CI (issues 1.5/1.6) and this root tooling work
end-to-end before real app code exists.

## Status

Tracking `Volar_V1_Backlog.xlsx` / `Volar_V1_Engineering_Execution_Plan.md`
(135 issues across 24 epics). See `docs/WORKING_AGREEMENT.md` for how
this backlog gets worked (one issue at a time, full verification, full
commit set per issue) — read that first if you're a fresh chat/session
picking this up.

**Completed:** Epics 1–5 (issues 1.1–1.10, 2.1–2.5, 3.1–3.4, 4.1–4.5,
5.1–5.5) — repo/infra scaffolding, auth & account foundations, core data
model (Organization/User/Project/APIKey/Tags), PriceTable & deterministic
cost engine, and LLMCallEvent ingestion (schema, cost-computed write
path, null-cost alerting, idempotency, reconciliation fixtures). Epic 6
(Ingestion API), issues 6.1–6.6 — `POST /v1/events` endpoint scaffold,
real API-key auth middleware (hash lookup, 24h rotation grace period,
revocation), request payload validation (shared zod schema per PRD
FR-6.5), batch support (array of events per FR-6.8, partial-failure-
tolerant), per-API-key rate limiting (429 + Retry-After, in-memory
fixed-window, documented 300 req/min threshold), and a fire-and-forget
`api_keys.last_used_at` update on successful auth (PRD §10.3 key-
activity visibility) on `apps/proxy`. Epic 7 (Managed Queue), issue
7.1 — ingestion queue provisioned via Supabase's `pgmq` extension
(judgment call over Upstash Redis/QStash, both PRD-sanctioned per NFR
§10.4 — see `supabase/migrations/20260902071700_ingestion_queue_pgmq.sql`),
live-verified enqueue/dequeue cycle, no new secrets required. Issue 7.2
— `POST /v1/events` now durably enqueues every validated event onto
`pgmq.q_ingestion_events` (via a `SECURITY DEFINER` RPC wrapper,
`public.enqueue_ingestion_event`, since `pgmq` isn't directly reachable
through PostgREST) instead of writing to `llm_call_events` directly; a
failed enqueue now fails the whole request (503, safe to retry given
issue 5.4's `event_id` idempotency) rather than silently dropping data.
Live testing caught and fixed a real access-control gap (`anon` could
call the wrapper despite a `revoke ... from public`) before merge — see
`docs/RLS.md`. Issue 7.3 — the consumer side of the queue: a background
worker (`apps/proxy/src/worker.ts`, running in-process alongside the
HTTP server by default — see that file's judgment-call comment) that
continuously dequeues messages (`public.dequeue_ingestion_events`,
another narrow RPC wrapper), re-validates each one (a queue message is
treated as untrusted input, not re-trusted just because issue 7.2
already validated it once), computes cost and inserts via issue 5.2's
`writeLlmCallEvent`, then archives only on a confirmed insert
(`public.archive_ingestion_event`). A message that fails validation or
insert is deliberately left unarchived — it becomes visible again via
`pgmq`'s own visibility timeout and gets retried, which is what makes
restart-safety (AC2) hold for free; a permanent poison-pill retrying
forever is issue 7.4's dead-letter problem, not this one's, per the
backlog's own framing. Issue 7.4 — dead-letter handling closes that gap:
once a message has been attempted `WORKER_MAX_ATTEMPTS` times (default
5, tracked via `pgmq`'s own per-message `read_ct`) and still fails, it's
moved into a new `public.ingestion_dead_letters` table (with the full
payload, failure reason, and last error attached) and removed from the
live queue, instead of retrying forever. No RPC wrapper needed for this
one — it's a plain table, not a `pgmq`-schema object — but it gets the
same default-deny RLS posture (enabled, no policies) as everything else
in this project; live-verified that `anon`/`authenticated` cannot write
to it while `service_role` can — see `docs/RLS.md`.

Issue 7.5 — burst-traffic load test, closing out Epic 7. A self-
provisioning script (`apps/proxy/src/load-test/`, run via
`pnpm --filter @volar/proxy load-test`) spins up a fresh org/projects/
API keys, fires a defined burst (10x normal event rate, spread across
10 simulated projects so no single API key ever approaches issue 6.5's
own rate limit), reconciles every sent event against
`llm_call_events`/`ingestion_dead_letters`, then tears the fixtures
back down. Live-verified against staging (a shortened run — 20s burst,
5,000 events): **zero events lost** — all 5,000 landed in
`llm_call_events`, 0 dead-lettered, 0 missing, even the handful of
requests the client itself saw a transient network error on. A real
correction made along the way, flagged rather than silently fixed: an
old comment in `events.test.ts` claimed proxy response time under load
*is* PRD NFR §10.2's SDK-overhead measurement — that stopped being true
once issue 7.2 made the endpoint enqueue-then-respond and FR-6.8's SDK
batches asynchronously, decoupling proxy latency from the customer's
actual call. This load test reports proxy latency under burst (a real,
useful capacity signal — p95 ~2.3s / p99 ~3.0s in the verification run,
driven by Supabase RPC fan-out contention, not errors) but that number
is no longer treated as NFR §10.2 itself; a true measurement needs a
real SDK (Epic 9/10). See `docs/RLS.md`'s "Load test fixtures" section
and issue 7.5's own delivery write-up for the full reasoning.

Epic 7 (Managed Queue) is complete.

Issue 8.0 — `public.daily_cost_rollups` (PRD §7 DailyCostRollup),
opening Epic 8 (Daily Rollup Job). The pre-aggregated table every
dashboard query in §5.2–§5.4 will read from instead of scanning raw
`llm_call_events` for any complete historical day. A real risk here,
checked rather than assumed: PRD §7's grain
`(project, date, provider, model, customer_id, feature_id)` isn't
actually enforced by a plain `UNIQUE` constraint when `customer_id`/
`feature_id` are both null — Postgres treats every `NULL` as distinct,
so two untagged rows for the same day/provider/model could otherwise
coexist, breaking the future rollup job's idempotent-upsert requirement
for what's likely the single most common case (no tags configured yet).
Fixed with two generated columns (`customer_id_key`/`feature_id_key`,
`coalesce(..., '')`) that the real unique constraint targets instead.
Live-verified: an untagged row inserted twice via the exact upsert
shape the rollup job will use collapsed into one row with correctly
summed totals, not two. RLS (project-scoped SELECT only, same posture
as `llm_call_events`) live-verified both directions — see
`docs/RLS.md`'s "DailyCostRollup (issue 8.0)" section.

**Next up:** issue 8.1 — scheduled job scaffold (cron) that will
eventually run the rollup aggregation once per day.

Per-area technical decisions and verification history: `docs/RLS.md`,
`docs/SECRETS.md`, `docs/CI.md`, `docs/PRICE_TABLE.md`.
