/**
 * Shared Prettier config (issue 1.10). Referenced from the repo root's
 * prettier.config.mjs so it applies workspace-wide with zero per-app
 * wiring — Prettier resolves config by walking up from the file being
 * formatted, so a single root file is sufficient.
 *
 * @type {import("prettier").Config}
 */
export default {
  semi: true,
  singleQuote: false,
  trailingComma: "all",
  printWidth: 80,
  tabWidth: 2,
};
