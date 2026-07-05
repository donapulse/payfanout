# @payfanout/adapter-stripe

Client-side Stripe adapter for [PayFanout](https://donapulse.github.io/payfanout/):
Stripe.js + the Payment Element, rendered embedded in your UI.

> **No secrets, no server code.** This package holds only a browser-safe publishable key.

It implements the `ClientPaymentAdapter` contract from `@payfanout/core` and plugs into
`@payfanout/react`, which renders the fields and drives the pay flow. Stripe.js is **loaded
lazily via a `<script>` tag** only when this adapter is actually mounted, there is nothing
extra to install and no SDK download during SSR.

📖 **Documentation:** <https://donapulse.github.io/payfanout/>
· [React usage](https://donapulse.github.io/payfanout/guide/react)
· [Set up Stripe](https://donapulse.github.io/payfanout/guide/stripe)

## Installation

```bash
pnpm add @payfanout/react @payfanout/adapter-stripe react react-dom
```

> **Not yet published to npm.** The packages are at `0.1.0`. Until a release is cut, consume
> them from source, see the [Installation guide](https://donapulse.github.io/payfanout/guide/installation).

## Usage

```tsx
import { PayFanoutProvider, PaymentFields, PayButton } from "@payfanout/react";
import { StripeClientAdapter } from "@payfanout/adapter-stripe";

const stripe = new StripeClientAdapter({
  publishableKey: "pk_test_…",   // browser-safe
  environment: "sandbox",        // never inferred from the key prefix
});

<PayFanoutProvider adapters={[stripe]} initialPsp="stripe">
  <PaymentFields clientSecret={session.clientSecret} appearance={designTokens} />
  <PayButton onResult={(result) => …}>Pay</PayButton>
</PayFanoutProvider>
```

This is a **confirm-on-client** PSP: the client confirms the PaymentIntent (inline 3DS) with
the `clientSecret` your server created via
[`@payfanout/adapter-stripe-server`](../adapter-stripe-server).

## What's inside

- **`StripeClientAdapter`**, mounts the Payment Element, confirms payments, and supports the
  redirect-return path (`payment_intent_client_secret` params resolve to the real intent
  status).
- Structural `StripeJs*` types (`StripeJsLike`, `StripeJsFactory`, `StripeJsConfirmResult`, …)
  so the adapter is testable without the real SDK.

Style the fields with your design tokens through `<PaymentFields>`: `appearance`, `locale`,
and `fieldOptions` (the Stripe Payment Element's full option surface, layout,
`paymentMethodOrder`, wallets, and more) are passthroughs.

## Documentation

- [React usage](https://donapulse.github.io/payfanout/guide/react)
- [Set up Stripe](https://donapulse.github.io/payfanout/guide/stripe)
- [API reference](https://donapulse.github.io/payfanout/api/)

## License

MIT
