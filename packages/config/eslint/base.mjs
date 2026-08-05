import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * Shared base ESLint flat-config array (issue 1.10, Epic 1 Conventions).
 * Every app/package in the workspace extends this rather than
 * redeclaring @eslint/js + typescript-eslint recommended rules itself.
 *
 * Framework-specific rules (e.g. eslint-config-next) are layered on top
 * locally by whichever app needs them — proxy and the SDK packages have
 * no business inheriting Next.js-specific lint rules, so those stay out
 * of this shared base rather than being centralized here.
 *
 * Node globals (module, require, process, etc.) are declared explicitly
 * because @eslint/js's own recommended config is environment-agnostic
 * and does not assume Node — without this, any plain CommonJS file
 * (e.g. a package's index.js) fails lint with `'module' is not defined`.
 */
export const baseConfig = tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    ignores: [
      "dist/**",
      ".next/**",
      "out/**",
      "build/**",
      "node_modules/**",
      "coverage/**",
    ],
  },
);
