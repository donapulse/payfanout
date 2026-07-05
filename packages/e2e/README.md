# @payfanout/e2e

Playwright browser end-to-end tests for [PayFanout](https://donapulse.github.io/payfanout/),
run against the demo app with real PSP sandbox keys.

> **Internal package**, private and unpublished (not part of the released library). It is the
> top of the test pyramid: the only layer that exercises the true Stripe.js / Paysafe.js
> SDKs, their iframes, and inline 3DS challenges. Specs **self-skip when keys are absent**,
> so the suite is green by default.

📖 **Documentation:** <https://donapulse.github.io/payfanout/>
· [Conformance suite](https://donapulse.github.io/payfanout/guide/conformance)

## Running it

One-time setup (downloads Chromium):

```bash
pnpm --filter @payfanout/e2e e2e:install
```

Run the suite (from the repo root), with the demo's client keys set:

```bash
pnpm run e2e
```

The Playwright config boots the demo app for you: the Express API + webhook server on
`:4242` and the Vite web server on `:5173` (`baseURL`). Provide the `VITE_`-prefixed client
keys (`VITE_STRIPE_PUBLISHABLE_KEY`, `VITE_PAYSAFE_PUBLIC_KEY`, `VITE_PAYSAFE_CURRENCY`) and
the server credentials to hit the real sandboxes; without them the specs skip.

## Where it fits

- Unit + [conformance](../conformance) suites run against in-memory PSP fakes, fast, always on.
- [Integration tests](../integration-tests) hit the real REST sandboxes, env-gated.
- **This package** drives the whole flow through a real browser.

See the [Conformance guide](https://donapulse.github.io/payfanout/guide/conformance) for the
full test pyramid, and [Installation](https://donapulse.github.io/payfanout/guide/installation)
for the demo app and its environment variables.

## Documentation

- [Conformance suite](https://donapulse.github.io/payfanout/guide/conformance)
- [Installation](https://donapulse.github.io/payfanout/guide/installation)
- [Documentation home](https://donapulse.github.io/payfanout/)
