# Installation

## Prerequisites

- **Node.js ≥ 18.17**
- **pnpm** (the repo is a pnpm workspace; `pnpm@10.24` is pinned via `packageManager`).
  npm/yarn work for consuming the published packages, but the monorepo scripts assume pnpm.
- **React ≥ 18** if you use `@payfanout/react` (declared as a peer dependency).

## Which packages do I need?

Install only the side(s) you run. `@payfanout/core` comes in transitively but can be added
explicitly. Adapters come as a client/server pair per PSP — swap `<psp>` below for the
package names in [Payment providers](/guide/providers), which lists every shipped adapter.
You don't have to install them all, add only the PSP(s) you use.

### Server side

```bash
pnpm add @payfanout/server @payfanout/adapter-<psp>-server
```

Server adapters carry the secret credentials. Every REST-based one is **edge-runtime
compatible** (WebCrypto only, no Node builtins) and runs on Cloudflare Workers / Next.js
edge routes; the Stripe adapter is the exception, because it bundles the Stripe Node SDK
(`stripe`) as a dependency.

### Client side (React)

```bash
pnpm add @payfanout/react @payfanout/adapter-<psp> react react-dom
```

The **client adapters have no npm dependency on the PSP browser SDKs**: each provider's SDK
is loaded **lazily via a `<script>` tag** only when its adapter is actually mounted. There is
nothing extra to `pnpm add` for them, and no SDK downloads during SSR.

## Environment variables

Keys never live in code, and every adapter requires an explicit
`environment: "sandbox" | "live"`, it is never inferred from a key prefix.

**The exact variables are per PSP, and each one's set-up guide lists its own** — names,
where to obtain each value, and which are optional. Start from
[Payment providers](/guide/providers) and open the guide for the PSP you're wiring up.
Three things hold across all of them:

- **Env-var names are yours, not the adapter's.** They differ from the adapter's config
  field names (a `PAYSAFE_SESSION_KEY` variable feeding `sessionSigningKey`, say); the
  guides show the mapping.
- **Not every value comes from the PSP.** Adapters that encode a stateless session sign it
  with a secret **you** generate (`openssl rand -hex 32`) and never share with the provider.
- **Client-side vars must be `VITE_`-prefixed** for Vite to expose them to the browser
  bundle. Only ever put browser-safe public keys there — a secret in a `VITE_` variable is
  a secret you have published.

A pinned provider `apiVersion` is **code, not configuration**: where a PSP has one, the
adapter pins it explicitly rather than reading it from the environment.

::: danger Never commit secrets
`.env` and `.env.*` are git-ignored on purpose. Sandbox or live, keys never enter the repo.
:::

## Next: set up your PSP

Package install is only half the job. The **per-PSP setup guides** take you from
credentials to a working payment, obtaining keys, wiring both adapter halves, registering
the webhook, and test values:

- **[Payment providers](/guide/providers)**, the shared four-step shape plus the table of
  every shipped adapter, linking to that PSP's own set-up guide.
- [Writing an adapter](/adapter-authoring), install a PSP we don't ship yet.

## Building from source (contributing)

Working on PayFanout itself, or need an unreleased change from `develop`? Use the
workspace directly:

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

The demo (`examples/demo`) shows every shipped PSP behind identical UI, switchable at runtime:

```bash
pnpm --filter payfanout-demo dev:server   # Express API + webhook endpoints on :4242
pnpm --filter payfanout-demo dev:web      # Vite dev server (proxies /api and /webhooks)
```

Set the variables for whichever PSPs you want live — each one's set-up guide lists them, and
`examples/demo/server.mts` shows the full set the demo reads. Don't forget the
**`VITE_`-prefixed client keys**, which a bare `<PSP>_*` glob would miss. Unset variables
fall back to inert placeholders, so the app boots but real charges need the real keys.
