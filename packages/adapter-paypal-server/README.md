# @payfanout/adapter-paypal-server

Server-side PayPal adapter for [PayFanout](https://donapulse.github.io/payfanout/):
Orders v2 REST (create / capture / authorize), refunds, webhook verification via PayPal's
postback API, and missed-webhook event polling.

> **Holds your API secret.** Never bundle this package client-side — the browser half is
> [`@payfanout/adapter-paypal`](../adapter-paypal).

**Edge-runtime compatible**: plain `fetch` + WebCrypto, no Node builtins, so it runs on
Cloudflare Workers and Next.js edge routes as well as Node ≥ 18.17 (a test guards this).

📖 **Documentation:** <https://donapulse.github.io/payfanout/>
· [Server usage](https://donapulse.github.io/payfanout/guide/server)
· [Set up PayPal](https://donapulse.github.io/payfanout/guide/paypal)

## Installation

```bash
pnpm add @payfanout/server @payfanout/adapter-paypal-server
```

> **Not yet published to npm.** The packages are at `0.1.0`. Until a release is cut, consume
> them from source, see the [Installation guide](https://donapulse.github.io/payfanout/guide/installation).

## Usage

```ts
import { PaymentService } from "@payfanout/server";
import { PayPalServerAdapter } from "@payfanout/adapter-paypal-server";

const paypal = new PayPalServerAdapter({
  clientId: process.env.PAYPAL_CLIENT_ID!,
  clientSecret: process.env.PAYPAL_CLIENT_SECRET!,
  environment: "sandbox", // explicit, never inferred
  webhookId: process.env.PAYPAL_WEBHOOK_ID, // required for webhook verification
});

const payments = new PaymentService({ adapters: [paypal] });
```

PayPal is **tokenize-first** (`requiresServerCompletion: true`): the buyer approves in the
PayPal popup, the client's `confirm()` hands back the approved order id as `clientToken`,
and your server moves the money with `completePayment`. Manual capture maps to
`intent: AUTHORIZE` with multi-capture support; refunds settle against the capture
(`PaymentInfo.pspPaymentId` is the capture id once captured — store it, order ids age out
of PayPal's GET after a few days).

See the [PayPal set-up guide](https://donapulse.github.io/payfanout/guide/paypal) for
credentials, the two-step button UX, webhook registration, and the currency rules
(no 3-decimal currencies; HUF/TWD/JPY are whole-unit).

## License

MIT
