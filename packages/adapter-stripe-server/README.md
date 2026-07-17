# @payfanout/adapter-stripe-server

Server-side Stripe adapter for [PayFanout](https://donapulse.github.io/payfanout/):
PaymentIntents, refunds, and webhook signature verification, over the Stripe Node SDK.

> **Holds secrets.** This package uses your Stripe secret key. Never bundle it client-side.

It implements the `ServerPaymentAdapter` contract from `@payfanout/core`, so
`@payfanout/server` drives it through the same unified API as every other PSP; your
application code never learns Stripe is the one running. It **pins an explicit
`apiVersion`** (required) and bundles the `stripe` SDK, so there is nothing else to install.

📖 **Documentation:** <https://donapulse.github.io/payfanout/>
· [Set up Stripe](https://donapulse.github.io/payfanout/guide/stripe)
· [Server usage](https://donapulse.github.io/payfanout/guide/server)

## Installation

```bash
pnpm add @payfanout/server @payfanout/adapter-stripe-server
```

`@payfanout/core` and the `stripe` SDK come in transitively.

## Usage

```ts
import { PaymentService } from "@payfanout/server";
import { StripeServerAdapter } from "@payfanout/adapter-stripe-server";

const stripe = new StripeServerAdapter({
  secretKey: process.env.STRIPE_SECRET_KEY!,        // sk_test_… / sk_live_…
  apiVersion: "2024-06-20",                         // pinned, required
  webhookSigningSecret: process.env.STRIPE_WEBHOOK_SECRET!, // whsec_… (string or array for rotation)
  environment: "sandbox",                           // never inferred from the key prefix
});

const payments = new PaymentService({ adapters: [stripe] });
```

Pair it on the browser with [`@payfanout/adapter-stripe`](../adapter-stripe). This is a
**confirm-on-client** PSP: the server creates the PaymentIntent, the client confirms
(inline 3DS), and `completePayment` is rejected for it.

## What's inside

- **`StripeServerAdapter`**, the full server contract (create/update/retrieve/capture/cancel,
  refunds, payment-method verification, saved-card charging, `fetchEvents`).
- **Native subscriptions (Stripe Billing)** — list/retrieve/create/cancel. Creation is
  server-only against a vaulted PaymentMethod: pass an existing Price id as `planId`, or
  omit it and the adapter builds the price inline (creating a Product on the fly, named
  after `merchantRefNum`). Listing returns Stripe's default set — every subscription that
  has not been canceled. Cancel is verified-idempotent: replaying it on an
  already-canceled subscription resolves as success.
- **Webhook helpers**, `verifyStripeWebhookSignature`, `parseStripeWebhookEvent`, and
  `stripeEventBodyToUnified`, all operating on the **raw request bytes** and emitting a
  normalized `UnifiedWebhookEvent`.
- **`mapStripeError`**, turns any Stripe error into a unified `PayFanoutError`, with the
  original preserved on `raw`.
- **`STRIPE_PSP_NAME`** and the `Stripe*Like` structural types.

## Notes

- The Stripe SDK retries network failures itself (`maxNetworkRetries`, default 2).
- Subscription creation sends `payment_behavior: "error_if_incomplete"`: a first invoice
  that cannot be paid rejects with the mapped card error instead of leaving an
  `incomplete` subscription behind. Canceling a subscription is a `DELETE`, where Stripe
  ignores idempotency keys — replay safety comes from re-fetching on rejection and
  treating an already-canceled subscription as success.
- Zero-amount payment-method verification uses a SetupIntent and **detaches the
  PaymentMethod on every path** to honor the no-storage constraint; set
  `verifyPaymentMethodStrategy: "disabled"` to turn the capability off instead.
- Webhook signing secrets accept an **array** so you can rotate without cutover.

## Documentation

- [Set up Stripe](https://donapulse.github.io/payfanout/guide/stripe)
- [Server usage](https://donapulse.github.io/payfanout/guide/server)
- [Webhooks](https://donapulse.github.io/payfanout/guide/webhooks)
- [API reference](https://donapulse.github.io/payfanout/api/)

## License

MIT
