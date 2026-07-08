# @payfanout/server

Server-side orchestration for [PayFanout](https://donapulse.github.io/payfanout/):
a `PaymentService` over a registry of adapters, a `PaymentRouter` for multi-PSP
failover, framework-agnostic webhook handlers, and a subscription billing engine.
Stateless, it persists nothing.

Application code calls one unified API and never learns which payment gateway is active.
PayFanout orchestrates and normalizes; your app owns the id mapping between its orders and
`pspPaymentId`s, the webhook dedupe store, and any audit log.

📖 **Documentation:** <https://donapulse.github.io/payfanout/>
· [Server usage](https://donapulse.github.io/payfanout/guide/server)
· [Webhooks](https://donapulse.github.io/payfanout/guide/webhooks)
· [Saved cards & subscriptions](https://donapulse.github.io/payfanout/guide/recurring)

## Installation

```bash
pnpm add @payfanout/server \
         @payfanout/adapter-stripe-server \
         @payfanout/adapter-paysafe-server
```

Add only the adapter(s) for the PSP(s) you use. `@payfanout/core` comes in transitively.

## Quick start

```ts
import { PaymentService, createAdapterWebhookHandler } from "@payfanout/server";
import { StripeServerAdapter } from "@payfanout/adapter-stripe-server";
import { PaysafeServerAdapter } from "@payfanout/adapter-paysafe-server";

const stripe = new StripeServerAdapter({
  secretKey: process.env.STRIPE_SECRET_KEY!,
  apiVersion: "2024-06-20",            // pinned, required
  webhookSigningSecret: process.env.STRIPE_WEBHOOK_SECRET!,
  environment: "sandbox",
});

const payments = new PaymentService({ adapters: [stripe] });

// One unified API, PSP named per call (PayFanout keeps no id mapping, you do):
const session = await payments.createPaymentSession("stripe", {
  id: order.id,
  amount: 1099,                 // ALWAYS integer minor units at this boundary
  currency: "USD",
  idempotencyKey: order.id,     // required on every mutating call
});
// -> session.clientSecret goes to the client
```

Later lifecycle calls: `retrievePayment`, `capturePayment`, `cancelPayment`,
`refundPayment`, `retrieveRefund` (poll `"pending"` refunds), `verifyPaymentMethod`,
`fetchEvents`, `listPayments`, `listRefunds` (capability-gated passthroughs).

## What's inside

- **`PaymentService`**, the unified API over an adapter registry, with an optional
  `telemetry` hook (metadata only, no amounts/ids/PII) called after every operation.
- **`PaymentRouter`**, picks the PSP per payment and cascades transient failures across
  PSPs by currency/country, with a circuit breaker that skips known-down providers. The
  `attempts` array is your audit trail. Failover applies to session creation only; every
  later call stays pinned to the PSP that won.
- **Webhook handlers**, `createAdapterWebhookHandler` (one endpoint per adapter) and
  `createUnifiedWebhookHandler` (one shared URL). Both emit a normalized
  `UnifiedWebhookEvent`. Signature verification requires the **raw request bytes**, see the
  [Webhooks guide](https://donapulse.github.io/payfanout/guide/webhooks).
- **Subscriptions**, `SubscriptionManager` supplies the billing logic (calendar-safe period
  math, deterministic renewal idempotency, retry/dunning, status transitions). You supply
  storage via the `SubscriptionStore` seam and a cron. `InMemorySubscriptionStore` and
  `addInterval` are included.

## Routing & failover

```ts
import { PaymentRouter } from "@payfanout/server";

const router = new PaymentRouter({
  service: payments,
  rules: [
    { when: { currency: ["CAD"] }, use: ["paysafe", "stripe"] }, // primary, then failover
    { when: { currency: ["EUR", "GBP"] }, use: ["stripe"] },
  ],
});
const { session, pspName, attempts } = await router.createPaymentSession(input);
```

Business rejections (`invalid_request`, `card_declined`) abort the cascade; only transient
trouble (`psp_unavailable`, `rate_limited`, `processing_error`, `retryable` errors) fails over.

## Where it fits

Pair `@payfanout/server` with a server adapter
([`@payfanout/adapter-stripe-server`](../adapter-stripe-server),
[`@payfanout/adapter-paysafe-server`](../adapter-paysafe-server)) and, on the browser,
[`@payfanout/react`](../react). Amounts crossing the server boundary are always integer
minor units, use the currency helpers from [`@payfanout/core`](../core).

## Documentation

- [Server usage](https://donapulse.github.io/payfanout/guide/server)
- [Webhooks](https://donapulse.github.io/payfanout/guide/webhooks)
- [Saved cards & subscriptions](https://donapulse.github.io/payfanout/guide/recurring)
- [API reference](https://donapulse.github.io/payfanout/api/)

## License

MIT
