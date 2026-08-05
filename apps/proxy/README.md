# @volar/proxy

Standalone Node/TypeScript ingestion service — deliberately **not** built as
Next.js API routes. Per the Blueprint's architecture decision, this service
needs persistent connections and predictable low-latency behavior under
production LLM traffic that serverless cold starts would undermine, so it
runs as its own long-lived process (deployed to Railway, issue 1.8 — not
Vercel).

Built with [Fastify](https://fastify.dev/) — chosen for its maturity as a
persistent-process Node HTTP framework, low request overhead (important
given the proxy's 50ms p95 latency budget, PRD NFR §10.2), and mature
plugin ecosystem for things Epic 6 will need (schema validation, rate
limiting).

## Local development

```bash
# from repo root
pnpm install
cp apps/proxy/.env.example apps/proxy/.env   # optional, defaults work as-is
pnpm --filter @volar/proxy dev
```

The service listens on `PORT` (default `8787`). Check it's up:

```bash
curl http://localhost:8787/health
```

## Scripts

- `pnpm --filter @volar/proxy dev` — run with hot reload (tsx watch)
- `pnpm --filter @volar/proxy build` — compile TypeScript to `dist/`
- `pnpm --filter @volar/proxy start` — run the compiled build (`dist/index.js`)
- `pnpm --filter @volar/proxy test` — run the unit test suite (Vitest)

## Structure

- `src/app.ts` — builds the Fastify instance and registers routes. Kept
  separate from the entrypoint so tests can use Fastify's `.inject()`
  against routes without binding a real port.
- `src/index.ts` — entrypoint; reads `PORT`/`HOST` and starts listening.
- `src/routes/health.ts` — `GET /health`, the only route in this scaffold.
  Real ingestion routes (`POST /v1/events` etc.) start in Epic 6.

## Deployment (issue 1.8)

Deployed on [Railway](https://railway.com), project **volar-proxy**
(`48ae158b-5c4f-430c-a205-5004861645fd`), workspace "Viv's Projects" —
chosen over Fly.io because a Railway MCP connector with real provisioning
tools was available. Two environments, one shared service ("volar"):

| Environment | URL | Auto-deploy | Purpose |
|---|---|---|---|
| `staging` | https://volar-staging.up.railway.app | On push to `main` | Verify a change is good before promoting |
| `production` | https://volar-production.up.railway.app | Manual only | Not yet receiving real customer traffic |

Service settings (both environments): Root Directory `apps/proxy`, build
command `pnpm install && pnpm --filter @volar/proxy build`, start command
`pnpm --filter @volar/proxy start`, healthcheck path `/health`, watch
paths `apps/proxy/**` + `packages/shared/**` (mirrors the CI workflow's
path filters, so unrelated dashboard changes don't trigger a proxy
rebuild).

**Root Directory is required here**, unlike Vercel's dashboard import —
Railway's build system (Railpack) validates that a `start` script/entry
point exists at whatever it considers the app root before it will honor a
custom Start Command override. The monorepo root `package.json` only has
Turbo scripts (`dev`/`build`/`lint`/`test`), no `start`, which fails that
check. Setting Root Directory to `apps/proxy` points Railpack at a
package.json that does have one, while `pnpm install` at the top of the
build command still runs against the full workspace so `packages/shared`
resolves correctly.

To promote a build from staging to production: redeploy the production
environment manually (Railway dashboard, or `railway redeploy` via the
CLI) once staging has been verified.
