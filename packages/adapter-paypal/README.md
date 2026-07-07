# @payfanout/adapter-paypal

Client-side PayPal adapter for [PayFanout](https://donapulse.github.io/payfanout/):
PayPal Buttons with popup approval, tokenize-first. No card fields — the buyer approves
inside PayPal's own window.

> **No secrets, no server code.** This package holds only the public client id.

It implements the `ClientPaymentAdapter` contract from `@payfanout/core` and plugs into
`@payfanout/react`. The PayPal JS SDK is **loaded lazily via a `<script>` tag** only when
this adapter is actually mounted — nothing extra to install, no SDK download during SSR.

📖 **Documentation:** <https://donapulse.github.io/payfanout/>
· [React usage](https://donapulse.github.io/payfanout/guide/react)
· [Set up PayPal](https://donapulse.github.io/payfanout/guide/paypal)

## Installation

```bash
pnpm add @payfanout/react @payfanout/adapter-paypal react react-dom
```

> **Not yet published to npm.** The packages are at `0.1.0`. Until a release is cut, consume
> them from source, see the [Installation guide](https://donapulse.github.io/payfanout/guide/installation).

## Usage

```tsx
import { PayFanoutProvider, PaymentFields, PayButton } from "@payfanout/react";
import { PayPalClientAdapter } from "@payfanout/adapter-paypal";

const paypal = new PayPalClientAdapter({
  clientId: import.meta.env.VITE_PAYPAL_CLIENT_ID, // public, browser-safe
  environment: "sandbox",
  currency: "USD", // the SDK bakes currency into its script URL — one currency per page load
});
```

The flow is two-step: `<PaymentFields>` renders the **PayPal button**; the buyer clicks
it, approves in the popup (it says "Continue"), and `onChange({ complete: true })` fires —
that enables your own Pay button, whose `confirm()` hands the approved order id to your
server-completion route (`completePayment` captures the money). Cancelling the popup
resets the state; the buyer can simply click the PayPal button again.

See the [PayPal set-up guide](https://donapulse.github.io/payfanout/guide/paypal) for the
full wiring, decline recovery, and currency rules.

## License

MIT
