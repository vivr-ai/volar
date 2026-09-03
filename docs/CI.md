# CI — Workflows & the Turborepo Build-Dependency Rule

Issues 1.5/1.6 (dashboard-ci.yml, proxy-ci.yml) and 5.5 (shared-ci.yml,
plus a real fix to the other two). One workflow per publishable
workspace member: `dashboard-ci.yml`, `proxy-ci.yml`, `shared-ci.yml`.
Each triggers only on pull requests touching its own app/package (plus
`packages/shared/**`, since both apps depend on it) and runs lint,
typecheck, and test for that package only — kept separate rather than
one monolithic workflow so an unrelated app's failure never blocks a PR
that doesn't touch it.

## A real bug found while closing issue 5.5

Issue 5.5's AC2 requires the reconciliation fixture suite to "run in CI
on every PR touching 4.3/4.4/5.2." Verifying that literally (not just
assuming the existing workflows already did this correctly) surfaced
two real problems:

**1. `packages/shared`'s own tests were never run by CI at all.**
`dashboard-ci.yml` and `proxy-ci.yml` both already triggered on
`packages/shared/**` changes, but they only ran `pnpm --filter
@volar/dashboard test` / `pnpm --filter @volar/proxy test` — each app's
*own* test script, never `packages/shared`'s. A PR that only touched
`packages/shared/src/compute-cost.ts` would trigger both workflows, but
neither would actually execute `compute-cost.test.ts`. Fixed by adding
`shared-ci.yml`.

**2. `pnpm --filter <pkg> <script>` silently skips Turborepo's build
graph.** Once `apps/proxy` started depending on `@volar/shared`'s
*compiled* output (issue 5.2 — `@volar/shared`'s `package.json` points
`"main": "dist/index.js"`), any CI step that runs `pnpm --filter
@volar/proxy test` directly — bypassing Turborepo entirely — fails with
`Cannot find package '@volar/shared'`, because `dist/` is never built
first. `turbo.json` already declares `lint`/`typecheck`/`test` as
`dependsOn: ["^build"]` specifically to prevent this, but that only
takes effect if the command actually goes *through* Turborepo.

Reproduced directly (not assumed) in a scratch pnpm+Turborepo workspace
mirroring this repo's shape: a bare `pnpm --filter @volar/proxy test`
failed with `ERR_MODULE_NOT_FOUND` on `@volar/shared/dist/index.js`;
the same test via `pnpm exec turbo run test --filter=@volar/proxy`
correctly built `@volar/shared` first (visible in the turbo log as a
separate `@volar/shared:build` step before `@volar/proxy:test`) and
passed.

**Fix:** every CI workflow's Lint/Typecheck/Test steps now run through
`pnpm exec turbo run <task> --filter=<package>` instead of a bare
`pnpm --filter <package> <task>`. Root-level scripts (`pnpm build`,
`pnpm test`, etc.) were already correct, since `package.json`'s
`"test": "turbo run test"` always went through Turborepo — only the
per-package CI invocations had this gap. Local development is
unaffected if you follow the root scripts (`pnpm build && pnpm test`),
but running a single package's script directly
(`pnpm --filter @volar/proxy test`) will still hit this same failure
locally if `packages/shared/dist` doesn't exist yet — run `pnpm build`
first, or use `pnpm exec turbo run test --filter=@volar/proxy` instead.

## `node_modules` going stale relative to the workspace (found while closing issue 6.1)

Symptom: `pnpm exec turbo run typecheck --filter=@volar/proxy` fails with
`Cannot find module '@volar/shared'` / `Cannot find module
'@supabase/supabase-js'` in files that weren't touched by the current
change, even though `pnpm exec turbo run lint` on the same package just
passed. Confirmed directly (not assumed): `packages/shared/dist/` was
present and correctly built, but `apps/proxy/node_modules` had no
`@volar/` or `@supabase/` entries at all — lint doesn't do module
resolution (no type-aware rules configured in `packages/config/eslint/base.mjs`),
so it can pass while typecheck, which does resolve real imports, fails.
Turborepo's own `Unable to calculate transitive closures: Workspace
'<pkg>' not found in lockfile` warning is a useful early sign of the same
underlying staleness.

Fix: `pnpm install` from the repo root, then re-run the failing
`turbo run <task> --filter=<package>` command. This repo lives inside an
OneDrive-synced folder; OneDrive is known to interfere with the
symlinks/hardlinks pnpm's store relies on, which is a plausible
contributor if this recurs (worth revisiting a non-synced repo location
if it does). If a bare `pnpm install` reports "Already up to date" but
the module-resolution errors persist, that points at sync-related
corruption rather than a simple stale lockfile, and is worth flagging
rather than repeatedly re-running install.

## Railway deploy failures — build root + lockfile drift (found while scoping issue 7.5)

Issue 7.5 (load test against staging) requires a working deployed
proxy. Checking Railway's actual deploy history (never done before this
point) revealed every deploy of the `volar` service, on both `staging`
and `production`, had failed since 2026-08-09 (issue 5.2's commit) —
long before this session, and undiscovered because nothing in the
process up to now checked deploy status after a push. Two independent,
real bugs, both now fixed:

**1. Wrong build root hid the pnpm workspace from Railway.** The
service's `rootDirectory` was set to `apps/proxy`, but `pnpm-lock.yaml`
and `pnpm-workspace.yaml` live at the monorepo root — one level up.
Scoped that way, Railway's build tool (Railpack) never saw them, so it
couldn't detect this is a pnpm workspace, fell back to `npm install`
against `apps/proxy/package.json`, and failed immediately with
`npm error Unsupported URL Type "workspace:": workspace:*` — npm has no
concept of the `workspace:*` protocol pnpm uses for internal package
links. The service's `buildCommand`/`startCommand` (`pnpm install &&
pnpm --filter @volar/proxy build` / `pnpm --filter @volar/proxy start`)
were already written assuming a repo-root working directory; only
`rootDirectory` was wrong. Fixed by setting `rootDirectory` to the repo
root for both environments — confirmed via fresh build logs that
Railway now correctly detects pnpm and runs `pnpm install
--frozen-lockfile` as its own install step, before the custom build
command even runs.

**2. `pnpm-lock.yaml` had drifted out of sync with `package.json`.**
Once (1) was fixed, the build got further and hit a second, real
failure: `ERR_PNPM_OUTDATED_LOCKFILE` — the committed lockfile didn't
have entries matching `packages/internal-cli/package.json`'s current
dependencies (`@volar/config`, `@types/node`, `eslint`, `tsx`,
`typescript`, `vitest`, `@supabase/supabase-js`). This means at some
point that file was edited without a real `pnpm install` run afterward
to update the lockfile — plausible given this session's own
`bash`-sandbox-can't-mount-the-real-repo constraint (see
`WORKING_AGREEMENT.md`'s known environment quirks) meant every local
verification pass this project has ever run used `npm install` in an
isolated scratch copy, not `pnpm install --frozen-lockfile` against the
real lockfile — so this drift was never caught locally, only by
Railway's own stricter frozen-lockfile install.

Fixed by regenerating `pnpm-lock.yaml` from the current `package.json`
files (`pnpm install --no-frozen-lockfile` in an isolated environment,
using the exact `pnpm@9.15.9` version pinned in the root
`package.json`'s `packageManager` field), then verifying
`pnpm install --frozen-lockfile` passes cleanly against the
regenerated file before committing it.

Once `SUPABASE_SERVICE_ROLE_KEY` was added (see below), a third
distinct bug surfaced: **Railway's `buildCommand` for this service was
itself a bare `pnpm --filter @volar/proxy build`** — exactly the
anti-pattern this doc's own "general rule" section (below) already
warns about. It bypasses Turborepo's dependency graph, so
`@volar/shared` was never built before `apps/proxy`'s `tsc` ran against
it, failing with `error TS2307: Cannot find module '@volar/shared'`.
This CI.md fix (issue 5.5) was only ever applied to the GitHub Actions
workflow files — Railway's own build command, a separate piece of
config, was never updated to match. Fixed by changing Railway's
`buildCommand` to `pnpm install && pnpm exec turbo run build
--filter=@volar/proxy` for both environments.

With that fixed, the build finally succeeded end to end — but the
container crashed immediately on boot with `Error: Node.js detected
but native WebSocket not found` (thrown inside
`@supabase/supabase-js`'s `@supabase/realtime-js` dependency, which
requires Node's native WebSocket support, added in Node 22). Railway
had been running Node 20 — the minimum this repo's root `package.json`
declared (`"engines": { "node": ">=20" }`), and Railpack picks the
*lowest* version satisfying that range, not the latest. This proxy
never actually uses Supabase Realtime, but `createClient()` still
constructs a `RealtimeClient` internally as a side effect, so the crash
happens on every real (non-test-double) client construction, Node <22,
regardless of whether Realtime features are ever used. Fixed by
bumping `engines.node` to `>=22` in the root `package.json`, and — for
consistency, since this exact crash would also hit any CI run that
ever exercises a real `createClient()` call, e.g. an unskipped
`*.live.test.ts` — bumping `node-version` from 20 to 22 in all three
GitHub Actions workflows (`dashboard-ci.yml`, `proxy-ci.yml`,
`shared-ci.yml`) to match.

**Still blocking, and outside what Claude can fix:** Railway has zero
environment variables configured on the `volar` service in either
environment (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, etc.), so
even a successful build will crash at boot (`index.ts` throws at
startup if `SUPABASE_SERVICE_ROLE_KEY` is unset, per issue 6.2).
`SUPABASE_URL` was set directly (not a secret, just the project's
public URL). `SUPABASE_SERVICE_ROLE_KEY` is a credential — per this
project's own security posture (`docs/SECRETS.md`) and Claude's own
operating rules, it must be set by Vivek directly in Railway's own
Variables UI, never typed or pasted through Claude. See this issue's
delivery write-up for the exact steps and the outcome once it was set.

## The general rule going forward

**Any script in a workspace package that consumes another workspace
package's compiled output must be invoked through
`pnpm exec turbo run <task> --filter=<package>` in CI (or in any script
meant to run a single package in isolation), never a bare
`pnpm --filter <package> <script>`.** The bare form only runs that one
package's own script with no awareness of `turbo.json`'s dependency
graph. This will come up again the moment any other package (e.g. a
future `apps/dashboard` consumer of `@volar/shared`, or `packages/sdk-node`
depending on `packages/shared`) starts importing another workspace
package's build output — reach for the `turbo run --filter` form
proactively rather than rediscovering this the same way.
