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

Tracking `Volar_V1_Backlog.xlsx` / `Volar_V1_Engineering_Execution_Plan.md`,
Epic 1 (Repo & Infra Scaffolding), issue 1.1. See that plan for the full
135-issue V1 backlog and milestone sequencing.
