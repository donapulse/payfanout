# @payfanout/core

Unified payment domain model, adapter contracts, and normalization helpers for
[PayFanout](https://donapulse.github.io/payfanout/). Zero PSP dependencies, zero
persistence, runs anywhere.

This is the foundation every other PayFanout package builds on. It defines the vocabulary
(payment sessions, statuses, refunds, webhook events, capabilities), the `ServerPaymentAdapter`
and `ClientPaymentAdapter` contracts a provider must implement, and the pure helpers
(currency math, error normalization, retries, log scrubbing, i18n) shared across server and
client. It is provider-agnostic: no gateway-specific code lives here, and adding a payment
gateway means implementing these contracts, not changing this package.

📖 **Documentation:** <https://donapulse.github.io/payfanout/>
· [Getting started](https://donapulse.github.io/payfanout/guide/getting-started)
· [API reference](https://donapulse.github.io/payfanout/api/)

## Installation

```bash
pnpm add @payfanout/core
```

`@payfanout/core` comes in transitively with the server and React packages, but you can add
it explicitly to use its helpers directly.

## What's inside

- **Domain model** (`PaymentSession`, `PaymentInfo`, `RefundInfo`, `UnifiedPaymentStatus`,
  `UnifiedWebhookEvent`, `AdapterCapabilities`, `PaymentMethodDetails`, and the
  `PAYMENT_STATUSES` / `WEBHOOK_EVENT_TYPES` / `PAYMENT_METHOD_TYPES` constant sets).
- **Adapter contracts** (`ServerPaymentAdapter`, `ClientPaymentAdapter`, and every input type:
  `CreatePaymentSessionInput`, `CompletePaymentInput`, `RefundRequest`, `MountOptions`, …).
- **Currency helpers**, integer minor units done right per currency (JPY has 0 decimals, BHD
  has 3): `toMinorUnits`, `fromMinorUnits`, `formatMinorUnits`, `getCurrencyExponent`,
  `normalizeCurrency`, `assertMinorUnitAmount`.
- **Errors**, one `PayFanoutError` (a real `Error` subclass) with a unified `code`, user-safe
  `message`, a `retryable` flag, and the untouched PSP error kept on `raw`. Plus
  `isPayFanoutError`, and localization via `registerErrorMessages` / `localizeError`.
- **Refund state**, `getRefundState(info)` derives `"none" | "partial" | "full"` (refund
  state is derived, never a payment status).
- **Retries**, `withRetry(fn, policy)` wraps any call with exponential backoff + jitter for
  `retryable` rejections; `defaultShouldRetry`.
- **Safe logging**, `scrubForLogging(raw)` deep-redacts PII/card/token fields and masks
  card-number-shaped strings.
- **i18n**, UI label + error-message catalogs (`registerUiLabels`, `getUiLabel`,
  `BUILT_IN_LOCALES`).

## Usage

```ts
import {
  toMinorUnits,
  formatMinorUnits,
  getRefundState,
  isPayFanoutError,
  withRetry,
} from "@payfanout/core";

toMinorUnits(10.99, "USD");   // 1099
toMinorUnits(500, "JPY");     // 500  (0-decimal currency)
formatMinorUnits(1099, "USD"); // "$10.99"

getRefundState(paymentInfo); // "none" | "partial" | "full"

try {
  await withRetry(() => adapter.refundPayment(req), { retries: 3 });
} catch (err) {
  if (isPayFanoutError(err)) {
    console.error(err.code, err.message, err.retryable); // e.g. "card_declined", ...
  }
}
```

## Where it fits

`@payfanout/core` is consumed by `@payfanout/server`, `@payfanout/react`, every adapter, and
`@payfanout/conformance`. If you are **writing a new adapter**, this is the package whose
contracts you implement, see
[Writing an adapter](https://donapulse.github.io/payfanout/adapter-authoring).

## Documentation

- [Getting started](https://donapulse.github.io/payfanout/guide/getting-started)
- [Server usage](https://donapulse.github.io/payfanout/guide/server)
- [Writing an adapter](https://donapulse.github.io/payfanout/adapter-authoring)
- [API reference](https://donapulse.github.io/payfanout/api/)

## License

MIT
