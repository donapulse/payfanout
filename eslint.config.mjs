// Flat ESLint config for the whole monorepo.
// typescript-eslint recommended (non-type-checked — the type-aware layer is
// `pnpm run typecheck`) + React hooks rules where hooks exist. No stylistic
// rules; formatting is not linting.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "coverage/**",
      "docs/api/**",
      "**/test-results/**",
      "**/playwright-report/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // `_`-prefixed = unused (callback signatures, destructuring).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      // `catch {}` with an explanatory comment is an accepted pattern here.
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    // Hooks correctness wherever React lives.
    files: ["packages/react/**/*.{ts,tsx}", "examples/demo/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    // Tests and fakes legitimately reach for looser typing ergonomics.
    files: ["**/test/**", "**/*.test.*", "packages/e2e/**"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  {
    // Node scripts (ESM) — Node globals without pulling in the `globals` package.
    files: ["scripts/**/*.mjs", "examples/demo/server.mts"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        URL: "readonly",
        Buffer: "readonly",
        fetch: "readonly",
        Response: "readonly",
        setTimeout: "readonly",
      },
    },
  },
);
