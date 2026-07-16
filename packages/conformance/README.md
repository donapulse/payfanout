# @payfanout/conformance

The shared conformance suite that every [PayFanout](https://donapulse.github.io/payfanout/)
adapter, present or future, must pass. It runs the **identical contract** against every
adapter, which is what makes "add a payment gateway by writing an adapter, with zero changes
to core or app code" a guarantee rather than a hope.

📖 **Documentation:** <https://donapulse.github.io/payfanout/>
· [Conformance suite](https://donapulse.github.io/payfanout/guide/conformance)
· [Writing an adapter](https://donapulse.github.io/payfanout/adapter-authoring)

## Installation

```bash
pnpm add -D @payfanout/conformance
```

`vitest` (>= 1.0) is a peer dependency; the suite runs inside your test runner.

## What the suite proves

- **Capability coherence**, an adapter cannot claim a capability it does not honor.
- **The money paths**: retrieve truth (amounts, ids, metadata), full refunds, accumulating
  partial refunds, over-refund rejection, pending-refund polling, capture and
  multi-capture amounts, and clean cancellation — proven against your fake, not trusted.
- **Integer minor-unit boundaries**, proven for JPY (0 decimals) and BHD (3 decimals).
- **Raw-body webhook signatures**, including the re-serialization trap: same JSON value,
  different bytes must be rejected — plus unknown-but-valid event types mapping to
  `"unknown"` on a correctly signed body.
- **Stable webhook dedupe ids**, `event.id` is a durable key across retries and replays.
- **Error normalization**, with the untouched PSP error preserved on `raw` and the
  documented `retryable` semantics per code.
- **Idempotency replay**, the same key twice yields the same result and one side effect.

## Usage

Implement the fixtures for your adapter and hand it to the runner from inside a Vitest file:

```ts
import {
  runServerAdapterConformanceTests,
  runClientAdapterConformanceTests,
} from "@payfanout/conformance";

runServerAdapterConformanceTests("acme", () => makeAdapterWithFake(), serverFixtures);
runClientAdapterConformanceTests("acme", () => makeClientAdapter(), clientFixtures);
```

Every shipped adapter pair is wired into these runners. A new adapter is **done when the
suite is green**, and core, server, React, and every consuming app stay untouched.

## Where it fits

This package sits at the bottom of the test pyramid (fast, always on, run against in-memory
PSP fakes). Integration tests
([`@payfanout/integration-tests`](../integration-tests)) and Playwright E2E
([`@payfanout/e2e`](../e2e)) layer on top against real sandboxes. See
[Writing an adapter](https://donapulse.github.io/payfanout/adapter-authoring) for the
step-by-step build.

## Documentation

- [Conformance suite](https://donapulse.github.io/payfanout/guide/conformance)
- [Writing an adapter](https://donapulse.github.io/payfanout/adapter-authoring)
- [API reference](https://donapulse.github.io/payfanout/api/)

## License

MIT
