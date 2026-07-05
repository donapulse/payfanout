# @payfanout/adapter-paysafe-server

Server-side Paysafe adapter for [PayFanout](https://donapulse.github.io/payfanout/):
Payment Handles, Payments, Settlements, Refunds, and Webhooks, over the Paysafe Payments
REST API.

> **Holds secrets.** This package uses your Paysafe REST credentials. Never bundle it
> client-side.

It implements the `ServerPaymentAdapter` contract from `@payfanout/core`, so
`@payfanout/server` drives it through the same unified API as every other PSP. It talks to
the REST API directly and is **edge-runtime compatible** (WebCrypto only, no Node builtins),
so it runs on Cloudflare Workers and Next.js edge routes.

📖 **Documentation:** <https://donapulse.github.io/payfanout/>
· [Set up Paysafe](https://donapulse.github.io/payfanout/guide/paysafe)
· [Server usage](https://donapulse.github.io/payfanout/guide/server)

## Installation

```bash
pnpm add @payfanout/server @payfanout/adapter-paysafe-server
```

`@payfanout/core` comes in transitively.

> **Not yet published to npm.** The packages are at `0.1.0`. Until a release is cut, consume
> them from source, see the [Installation guide](https://donapulse.github.io/payfanout/guide/installation).

## Usage

```ts
import { PaymentService } from "@payfanout/server";
import { PaysafeServerAdapter } from "@payfanout/adapter-paysafe-server";

const paysafe = new PaysafeServerAdapter({
  username: process.env.PAYSAFE_USERNAME!,
  password: process.env.PAYSAFE_PASSWORD!,
  environment: "sandbox",                       // never inferred from credentials
  merchantAccountResolver: (currency, country) => lookupAccount(currency, country), // required
  sessionSigningKey: process.env.PAYSAFE_SESSION_KEY!,   // signs the stateless session context
  webhookHmacKey: process.env.PAYSAFE_WEBHOOK_HMAC_KEY!, // string or array for rotation
});

const payments = new PaymentService({ adapters: [paysafe] });
```

Pair it on the browser with [`@payfanout/adapter-paysafe`](../adapter-paysafe). This is a
**tokenize-first** PSP: the client tokenizes first, then your server finalizes the payment
via `completePayment` (wire a server-completion route for it).

## The signed, stateless session

Because PayFanout persists nothing, this adapter's session is a **signed, self-contained
context**: amount, currency, and merchant account are HMAC-signed into `pspSessionId` at
creation and verified at `completePayment`. The browser round-trips the token but cannot
tamper with the amount, and every context carries an **expiry** (`sessionTtlSeconds`,
default 1h) enforced at completion. `encodeSessionContext` / `decodeSessionContext` are
exported for advanced use.

## What's inside

- **`PaysafeServerAdapter`**, the full server contract (create/update/complete/retrieve,
  captures, refunds, settlements, verification via the Verifications API, saved-card
  charging).
- **Webhook helpers**, `verifyPaysafeWebhookSignature` and `parsePaysafeWebhookEvent`,
  operating on the **raw request bytes** and emitting a normalized `UnifiedWebhookEvent`.
  Paysafe retries webhooks effectively forever until it sees a 2xx.
- **`mapPaysafeError`**, unifies Paysafe errors into `PayFanoutError` (business errors like
  declines or `3406` are never replayed), and **`PAYSAFE_PSP_NAME`**.

## Notes

- The Paysafe transport retries timeouts/5xx/429 with backoff (`maxNetworkRetries`,
  default 2).
- Paysafe has no public events API (`supportsEventPolling: false`), so missed-webhook
  recovery falls back to `retrievePayment` per order.

## Documentation

- [Set up Paysafe](https://donapulse.github.io/payfanout/guide/paysafe)
- [Server usage](https://donapulse.github.io/payfanout/guide/server)
- [Webhooks](https://donapulse.github.io/payfanout/guide/webhooks)
- [API reference](https://donapulse.github.io/payfanout/api/)

## License

MIT
