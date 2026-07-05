# @payfanout/integration-tests

Env-gated integration tests for [PayFanout](https://donapulse.github.io/payfanout/),
running the server adapters against real PSP sandbox REST APIs.

> **Internal package**, private and unpublished (not part of the released library). The
> suites are **skipped and green until credentials are present**, then they validate every
> assumption the in-memory fakes encode: REST paths, auth formats, idempotency semantics,
> status transitions, and payload shapes.

📖 **Documentation:** <https://donapulse.github.io/payfanout/>
· [Conformance suite](https://donapulse.github.io/payfanout/guide/conformance)
· [Server usage](https://donapulse.github.io/payfanout/guide/server)

## Running it

From the repo root, with sandbox credentials in the environment:

```bash
pnpm run test:integration
```

The suites refuse live keys (Stripe keys must start with `sk_test_`, the Paysafe base URL
must be the sandbox). The **full list of environment variables**, plus the manual
webhook-delivery steps (Stripe CLI / tunnel), is in
[`test/README.md`](./test/README.md). Keys are read from the environment only, never commit
them.

## Where it fits

This is the middle layer of the test pyramid:

- Unit + [conformance](../conformance) suites run against in-memory PSP fakes, fast, always on.
- **This package** hits the real REST sandboxes to prove the fakes honest, env-gated.
- [Playwright E2E](../e2e) drives the whole flow through a real browser.

## Documentation

- [Conformance suite](https://donapulse.github.io/payfanout/guide/conformance)
- [Server usage](https://donapulse.github.io/payfanout/guide/server)
- [Webhooks](https://donapulse.github.io/payfanout/guide/webhooks)
- [Documentation home](https://donapulse.github.io/payfanout/)
