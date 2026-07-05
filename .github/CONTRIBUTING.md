# Contributing to PayFanout

Thanks for your interest in improving PayFanout. This guide covers local setup, the checks we run, and the conventions that keep the codebase consistent.

By participating you agree to abide by our [Code of Conduct](./CODE_OF_CONDUCT.md).

## Prerequisites

- Node.js `>=18.17` (CI runs the test matrix on 20 and 22).
- pnpm `10.24.0`. The simplest way to get the right version is Corepack:

  ```bash
  corepack enable
  corepack prepare pnpm@10.24.0 --activate
  ```

## Getting started

```bash
git clone https://github.com/donapulse/payfanout.git
cd payfanout
pnpm install
```

Run the full quality gate before you push. It is the same gate CI runs:

```bash
pnpm run check
```

That runs, in order: `typecheck`, `lint`, `check:boundaries`, and the test suite. If it passes locally, CI should be green too.

## Repository layout

This is a pnpm workspace. Every package lives under `packages/` and publishes under the `@payfanout/*` scope:

| Path | What it is |
| --- | --- |
| `packages/core` | Provider-agnostic domain model and adapter contracts. Zero dependencies, zero provider code. |
| `packages/server` | `PaymentService`, `PaymentRouter`, and framework-agnostic webhook handlers. Server only. |
| `packages/react` | Provider, hooks, and embedded UI components. Client only. |
| `packages/adapter-*` | Provider integrations, split into client and server packages. |
| `packages/conformance` | The contract suite every adapter must pass. |
| `packages/integration-tests`, `packages/e2e` | Real-sandbox suites. They need credentials and run in dedicated workflows. |

## The invariants that matter

A few rules are enforced mechanically, not by convention. Please respect them:

1. **Client packages never carry secrets.** Anything that runs in the browser must not import secret-bearing code. `scripts/check-boundaries.mjs` (part of `pnpm run check`) enforces this. If you need a secret, it belongs in a server package.
2. **No raw card inputs.** Card capture happens only in the provider's hosted iframe or tokenization SDK. There is no raw card `<input>` anywhere.
3. **Every adapter config requires an explicit `environment`** of `"sandbox"` or `"live"`. Never infer it from a key prefix.
4. **Money is always integer minor units** at the API boundary.

## Working on an adapter

The adapter contract lives in `@payfanout/core` and is verified by `@payfanout/conformance`. Any adapter, present or future, must pass that suite unchanged. Start from [docs/adapter-authoring.md](../docs/adapter-authoring.md) and wire your adapter into the conformance runner. If your change alters the contract itself, expect to update core, the conformance suite, and every existing adapter together.

## Tests

- `pnpm test` runs the unit and conformance suites.
- `pnpm run test:coverage` enforces coverage thresholds (CI runs this).
- `pnpm run test:watch` gives a fast local loop.
- `pnpm run test:integration` and `pnpm run e2e` hit real provider sandboxes and need credentials, so they run in their own workflows rather than on every push.

Add or update tests for any behavior change. A failing conformance case is the ideal bug report.

## Changesets

We version and release with [Changesets](https://github.com/changesets/changesets). For any change that affects a published package, add a changeset:

```bash
pnpm changeset
```

Pick the affected packages and a semver bump (patch, minor, or major), and write a short, human-readable summary. Internal-only changes (CI, tests, docs) do not need one.

## Commit and pull request conventions

- Branch off `main`.
- Keep pull requests focused; smaller is easier to review.
- Fill out the pull request template, including the checklist.
- Make sure `pnpm run check` passes and you have added a changeset if one is needed.
- Never commit secrets, API keys, or real cardholder data. Use the sandbox test values from the provider docs.

## Reporting bugs and requesting features

Use the issue templates. For anything that looks like a security vulnerability, do not open a public issue; follow the [security policy](./SECURITY.md) instead.

Thanks again for contributing.
