# Installation

## Prerequisites

- **Node.js ≥ 18.17**
- **pnpm** (the repo is a pnpm workspace; `pnpm@10.24` is pinned via `packageManager`).
  npm/yarn work for consuming the published packages, but the monorepo scripts assume pnpm.
- **React ≥ 18** if you use `@payfanout/react` (declared as a peer dependency).

::: warning Not published to npm yet
The packages are at `0.1.0` and **not yet published to the public registry**, so
`pnpm add @payfanout/core` will not resolve today. Until a release is cut
(`pnpm run release`, via Changesets), consume the library **from source**, see
[Using it now, from source](#using-it-now-from-source) below. The commands in the next
section are what installation will look like **once published**.
:::

## Which packages do I need?

Install only the side(s) you run. `@payfanout/core` comes in transitively but can be added
explicitly.

### Server side

```bash
pnpm add @payfanout/server \
         @payfanout/adapter-stripe-server \
         @payfanout/adapter-paysafe-server
```

- The **Stripe** server adapter bundles the Stripe Node SDK (`stripe`) as a dependency,
  nothing else to install.
- The **Paysafe** server adapter talks to the Payments REST API directly and is
  **edge-runtime compatible** (WebCrypto only, no Node builtins), it runs on Cloudflare
  Workers / Next.js edge routes.
- You don't have to install both adapters, add only the PSP(s) you use.

### Client side (React)

```bash
pnpm add @payfanout/react \
         @payfanout/adapter-stripe \
         @payfanout/adapter-paysafe \
         react react-dom
```

The **client adapters have no npm dependency on the PSP browser SDKs**: Stripe.js and
Paysafe.js are loaded **lazily via a `<script>` tag** only when the adapter is actually
mounted. There is nothing extra to `pnpm add` for them, and no SDK downloads during SSR.

## Environment variables

Keys never live in code, and every adapter requires an explicit
`environment: "sandbox" | "live"`, it is never inferred from a key prefix. Note that
env-var names differ from adapter field names (e.g. `PAYSAFE_SESSION_KEY` feeds
`sessionSigningKey`); **where to obtain each value is in the per-PSP setup guides** below.

| Variable | Side | Feeds | Notes |
| --- | --- | --- | --- |
| `STRIPE_SECRET_KEY` | server | Stripe `secretKey` | `sk_test_…` / `sk_live_…` |
| `STRIPE_WEBHOOK_SECRET` | server | Stripe `webhookSigningSecret` | `whsec_…` |
| `VITE_STRIPE_PUBLISHABLE_KEY` | client | Stripe `publishableKey` | `pk_test_…` / `pk_live_…` |
| `PAYSAFE_USERNAME` / `PAYSAFE_PASSWORD` | server | Paysafe `username` / `password` | Basic-auth REST credentials |
| `PAYSAFE_ACCOUNT_ID` | server | `merchantAccountResolver` return | one per currency/country; omit for single-account keys |
| `PAYSAFE_SESSION_KEY` | server | Paysafe `sessionSigningKey` | **you generate this** (`openssl rand -hex 32`), not a Paysafe credential |
| `PAYSAFE_WEBHOOK_HMAC_KEY` | server | Paysafe `webhookHmacKey` | from the Paysafe portal |
| `VITE_PAYSAFE_PUBLIC_KEY` | client | Paysafe `apiKey` | public single-use-token Base64 key |
| `VITE_PAYSAFE_CURRENCY` | client | session currency (demo) | match your sandbox account's currency (often CAD) |

Stripe's `apiVersion` is **pinned in code**, not an env var (see [Set up Stripe](/guide/stripe)).
Client vars must be `VITE_`-prefixed for Vite to expose them to the browser bundle.

::: danger Never commit secrets
`.env` and `.env.*` are git-ignored on purpose. Sandbox or live, keys never enter the repo.
:::

## Next: set up your PSP

Package install is only half the job. The **per-PSP setup guides** take you from
credentials to a working payment, obtaining keys, wiring both adapters, registering the
webhook, and test cards:

- [Payment providers overview](/guide/providers), the shared four-step shape.
- [Set up Stripe](/guide/stripe) · [Set up Paysafe](/guide/paysafe)
- [Writing an adapter](/adapter-authoring), install a PSP we don't ship yet.

## Using it now, from source

Until a release is published, use the workspace directly:

```bash
git clone <this-repo>
cd <repo>
pnpm install          # installs every workspace package
pnpm run build        # tsc-emits each package to dist/ (published exports point here)
pnpm run check        # typecheck + lint + package-boundary check + all tests
```

Inside the monorepo, packages resolve via `workspace:*` and their `exports` point at the
**TypeScript source** (`./src/index.ts`), a TS-aware bundler or `tsx` consumes them
directly, no build required (this is how the demo runs). The compiled `dist/` only exists
after `pnpm run build`; you need it to consume a package from **another** local project via
a `file:` / `link:` dependency pointing at `packages/<name>`.

## Verify your setup

```bash
pnpm run check   # green here means types, lint, boundaries, and tests all pass
```

Then jump to [Server usage](/guide/server) or, if you just want to see everything working
end-to-end, run the demo app described in [Getting started](/guide/getting-started).

## Try the demo app

The demo (`examples/demo`) shows both PSPs behind identical UI, switchable at runtime:

```bash
pnpm --filter payfanout-demo dev:server   # Express API + webhook endpoints on :4242
pnpm --filter payfanout-demo dev:web      # Vite dev server (proxies /api and /webhooks)
```

Set the Stripe and Paysafe variables from the [table above](#environment-variables) to hit
the real sandboxes, including the **`VITE_`-prefixed client keys**
(`VITE_STRIPE_PUBLISHABLE_KEY`, `VITE_PAYSAFE_PUBLIC_KEY`) and `VITE_PAYSAFE_CURRENCY`,
which a bare `PAYSAFE_*` glob would miss. Unset variables fall back to inert placeholders,
so the app boots but real charges need the real keys.
