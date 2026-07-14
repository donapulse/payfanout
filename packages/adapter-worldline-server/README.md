# @payfanout/adapter-worldline-server

Server-side Worldline Direct adapter for [PayFanout](https://donapulse.github.io/payfanout/):
Hosted Tokenization, Payments, Captures, Refunds, and Webhooks, over the Worldline Direct
Online Payments REST API (v2).

> **Holds secrets.** This package uses your Worldline Direct API key and secret. Never
> bundle it client-side.

It implements the `ServerPaymentAdapter` contract from `@payfanout/core`, so
`@payfanout/server` drives it through the same unified API as every other PSP. It talks to
the REST API directly and is **edge-runtime compatible** (WebCrypto only, no Node builtins),
so it runs on Cloudflare Workers and Next.js edge routes.

📖 **Documentation:** <https://donapulse.github.io/payfanout/>
· [Set up Worldline](https://donapulse.github.io/payfanout/guide/worldline)
· [Server usage](https://donapulse.github.io/payfanout/guide/server)

## Installation

```bash
pnpm add @payfanout/server @payfanout/adapter-worldline-server
```

`@payfanout/core` comes in transitively.

## Usage

```ts
import { PaymentService } from "@payfanout/server";
import { WorldlineServerAdapter } from "@payfanout/adapter-worldline-server";

const worldline = new WorldlineServerAdapter({
  apiKeyId: process.env.WORLDLINE_API_KEY_ID!,
  secretApiKey: process.env.WORLDLINE_SECRET_API_KEY!,
  merchantId: process.env.WORLDLINE_MERCHANT_ID!,
  environment: "sandbox",                               // never inferred from credentials
  sessionSigningKey: process.env.WORLDLINE_SESSION_KEY!, // signs the stateless session context
  webhookKeys: [
    { keyId: process.env.WORLDLINE_WEBHOOKS_KEY_ID!, secretKey: process.env.WORLDLINE_WEBHOOKS_SECRET_KEY! },
  ], // one key, or several during rotation — any active key verifying wins
});

const payments = new PaymentService({ adapters: [worldline] });
```

Pair it on the browser with [`@payfanout/adapter-worldline`](../adapter-worldline). This is a
**tokenize-first** PSP: the browser tokenizes the card into a `hostedTokenizationId` with the
Hosted Tokenization Page, then your server finalizes the payment via `completePayment` (wire a
server-completion route for it).

## The signed, stateless session

Because PayFanout persists nothing, this adapter's session is a **signed, self-contained
context**: amount, currency, capture method, and the `hostedTokenizationId` are HMAC-signed
into `pspSessionId` at creation and verified at `completePayment`. The browser round-trips the
token but cannot tamper with the amount, and every context carries an **expiry**
(`sessionTtlSeconds`, default 1h) enforced at completion. `encodeSessionContext` /
`decodeSessionContext` are exported for advanced use.

Worldline Direct has no arbitrary metadata map on a payment, so the host id round-trips via
`order.references.merchantReference` only (`PaymentInfo.id`); host metadata is not echoed on
`retrievePayment`.

## Authentication

Requests are signed with Worldline's **`v1HMAC`** scheme (`Authorization: GCS v1HMAC:{apiKeyId}:{signature}`)
using WebCrypto — no `node:crypto`, so the adapter stays edge-compatible. The `Date` header is
sent and signed (RFC-1123 GMT); Worldline rejects timestamps older than five minutes, so the
clock is an injectable `now()` seam. Every mutating call carries a signed, deterministic
`X-GCS-Idempotence-Key` derived from the caller's `idempotencyKey`.

## What's inside

- **`WorldlineServerAdapter`**, the full server contract (create session / complete /
  retrieve, manual capture, cancel, refunds, refund polling).
- **Webhook helpers**, `verifyWorldlineWebhookSignature` and `parseWorldlineWebhookEvent`,
  operating on the **raw request bytes** and emitting a normalized `UnifiedWebhookEvent`. One
  event per delivery; a single-event array wrapper is unwrapped, and a multi-event batch is
  rejected rather than partially processed.
- **`mapWorldlineError`**, unifies Worldline errors into `PayFanoutError` (business rejections
  are never replayed), and **`WORLDLINE_PSP_NAME`**.
- **`buildV1HmacAuthorization`**, the request signer, exported for testing.

## Notes

- The transport retries timeouts/5xx/429 with backoff (`maxNetworkRetries`, default 2); every
  money-moving call is idempotent, so a replay can never double-charge.
- Worldline Direct has no refund-by-id endpoint, so `refundPayment` returns a **composite
  `refundId`** (`{paymentId}:{refundId}`) that `retrieveRefund` resolves through the payment's
  refund list. The part after the last `:` is Worldline's own refund id — the one webhooks
  report.
- Worldline Direct exposes no public events-list API (`supportsEventPolling: false`), so
  missed-webhook recovery falls back to `retrievePayment` per order.
- Card vaulting, zero-amount verification, session update, and listing are out of scope for
  this version (declared `false`).

## Documentation

- [Set up Worldline](https://donapulse.github.io/payfanout/guide/worldline)
- [Server usage](https://donapulse.github.io/payfanout/guide/server)
- [Webhooks](https://donapulse.github.io/payfanout/guide/webhooks)
- [API reference](https://donapulse.github.io/payfanout/api/)

## License

MIT
