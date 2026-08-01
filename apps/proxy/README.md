# @volar/proxy

Standalone Node/TypeScript ingestion service — deliberately **not** built as
Next.js API routes. Per the Blueprint's architecture decision, this service
needs persistent connections and predictable low-latency behavior under
production LLM traffic that serverless cold starts would undermine, so it
runs as its own long-lived process (deployed to Fly.io/Railway in issue
1.8, not Vercel).

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

## Status

Scaffolded in Engineering Execution Plan issue 1.3 (Epic 1). Ingestion
logic (auth, validation, queueing) is out of scope here — see Epic 6
(Ingestion API).
