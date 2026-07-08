# Conformance: how "extensible" stays true

`@payfanout/conformance` runs the **identical contract** against every adapter, the reason
"add a PSP by writing an adapter, with zero changes to core or app code" is a guarantee and
not a hope.

## What the suite proves

- **Capability coherence**, an adapter can't claim a capability it doesn't honor.
- **Integer-minor-unit boundaries** proven for JPY (0 decimals) and BHD (3 decimals).
- **Raw-body webhook signatures**, including the re-serialization trap: same JSON value,
  different bytes ⇒ the adapter must reject.
- **Stable webhook dedupe ids**, `event.id` is a durable key across retries/replays.
- **Error normalization** with the untouched PSP error preserved on `raw`.
- **Idempotency replay**, same key twice → same result, one side effect.

Every shipped adapter passes the same suite; a future adapter is **done when
it does too**.

## Running it

The conformance tests run as part of the normal test suite:

```bash
pnpm run test          # unit + shared conformance suites against in-memory PSP fakes
pnpm run test:coverage # enforces coverage thresholds (92% lines / 82% branches)
```

The test pyramid layers on top of this:

- **unit + conformance** against in-memory PSP fakes, fast, always on;
- **integration** against real sandboxes, env-gated, validates every assumption the fakes
  encode (`pnpm run test:integration`);
- **Playwright E2E** through the demo app, real Stripe.js / Paysafe.js iframes, inline 3DS
  (`pnpm run e2e`).

## Writing a new adapter

The step-by-step guide for adding the next PSP lives in
[Writing an adapter](/adapter-authoring). The short version: implement the
`ServerPaymentAdapter` / `ClientPaymentAdapter` contract from `@payfanout/core`, then wire
your adapter into `runServerAdapterConformanceTests` / `runClientAdapterConformanceTests`
from `@payfanout/conformance`. When the suite is green, you're done, and core, server, and
every consuming app stay untouched.
