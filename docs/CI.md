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
