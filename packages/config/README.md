# @volar/config

Shared ESLint, TypeScript, and Prettier configuration for the Volar
monorepo (issue 1.10, Epic 1). Not published — a private workspace-only
package that other apps/packages depend on via `workspace:*`.

## What's centralized vs. left per-app

- **ESLint** (`./eslint/base`): the common `@eslint/js` + `typescript-eslint`
  recommended rule sets and shared ignore patterns. Framework-specific
  rules (Next.js's `eslint-config-next`) are layered on top locally by
  `apps/dashboard` — they don't belong in a base every package inherits.
- **TypeScript** (`./typescript/base`): only `strict` and the handful of
  interop/consistency settings that are safe to be identical everywhere.
  `target`, `module`, and `moduleResolution` are deliberately **not**
  centralized — `apps/dashboard` (Next.js, `bundler` resolution) and
  `apps/proxy` (plain Node/ESM, `NodeNext` resolution) have genuinely
  different correct values, and forcing one would break the other.
- **Prettier** (`./prettier`): fully shared — there's no legitimate
  reason for formatting rules to differ by app. Applied workspace-wide
  via the root `prettier.config.mjs`, not per-package.

## Usage

ESLint (`eslint.config.mjs` in any app/package):

```js
import { baseConfig } from "@volar/config/eslint/base";
export default baseConfig; // or spread it alongside framework-specific rules
```

TypeScript (`tsconfig.json` in any app/package):

```json
{
  "extends": "@volar/config/typescript/base",
  "compilerOptions": {/* app-specific overrides */}
}
```
