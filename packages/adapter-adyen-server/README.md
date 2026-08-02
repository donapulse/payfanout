# @payfanout/adapter-adyen-server

Server-side Adyen adapter for [PayFanout](https://donapulse.github.io/payfanout/): payments,
captures, cancels, refunds, and standard webhooks over the Adyen Checkout API (v72).

> **Holds secrets.** This package uses your Adyen API key. Never bundle it client-side.

It implements the `ServerPaymentAdapter` contract from `@payfanout/core`, so
`@payfanout/server` drives it through the same unified API as every other PSP. It talks to
the REST API directly and is **edge-runtime compatible** (WebCrypto only, no Node builtins),
so it runs on Cloudflare Workers and Next.js edge routes.

📖 **Documentation:** <https://donapulse.github.io/payfanout/>
· [Set up Adyen](https://donapulse.github.io/payfanout/guide/adyen)
· [Server usage](https://donapulse.github.io/payfanout/guide/server)

## Installation

```bash
pnpm add @payfanout/server @payfanout/adapter-adyen-server
```

`@payfanout/core` comes in transitively.

## Usage

```ts
import { PaymentService } from "@payfanout/server";
import { AdyenServerAdapter } from "@payfanout/adapter-adyen-server";

const adyen = new AdyenServerAdapter({
  apiKey: process.env.ADYEN_API_KEY!,
  merchantAccount: process.env.ADYEN_MERCHANT_ACCOUNT!,
  environment: "sandbox",                            // never inferred from credentials
  sessionSigningKey: process.env.ADYEN_SESSION_KEY!, // signs the stateless session context
  hmacKeys: [process.env.ADYEN_HMAC_KEY!],           // hex, one key or several during rotation
  webhookBasicAuth: {
    username: process.env.ADYEN_WEBHOOK_USERNAME!,
    password: process.env.ADYEN_WEBHOOK_PASSWORD!,
  },
  // Adyen requires returnUrl on every payment; sessions may override it per payment.
  defaultReturnUrl: "https://your-shop.example/checkout/return",
});

const payments = new PaymentService({ adapters: [adyen] });
```

Pair it on the browser with [`@payfanout/adapter-adyen`](../adapter-adyen). This is a
**tokenize-first** PSP: the browser encrypts the card in Adyen's hosted fields, then your
server finalizes the payment via `completePayment` (wire a server-completion route for it).

## Push-only: outcomes arrive by webhook

Adyen's Checkout API takes its `pspReference` as a **write target**. There is no read for a
payment or for a refund, and captures, cancels and refunds answer `{ "status": "received" }`
— an acknowledgement, not a result. The adapter declares exactly that
(`supportsPaymentRetrieval: false`, `supportsRefundRetrieval: false`,
`modificationOutcome: "asynchronous"`), so `capturePayment` and `cancelPayment` resolve
`"processing"` and refunds resolve `"pending"`. Nothing reports a terminal state Adyen has
not confirmed; the confirmation is the webhook.

Two consequences worth designing around:

- **`PaymentInfo.pspPaymentId` is the composite `"{pspReference}:{value}:{currency}"`.** A
  capture or refund needs the payment's currency (and, without an explicit amount, its
  value), and with no read and no persistence the money facts have to travel with the
  reference. `cancelPayment` accepts a bare `pspReference`; the part before the first `:` is
  Adyen's own reference, the one webhooks report. Because it carries an amount, treat the
  composite as server-side state: read it from your own record, never from a client request
  body. A cancel driven from a bare reference reports `amount: 0` and `currency: "XXX"`,
  since no money facts travel on one.
- **The webhook endpoint is the system of record.** There is no events-polling API either
  (`supportsEventPolling: false`), so persist every event and dedupe by `event.id`.

## The signed, stateless session

Adyen creates nothing at session time, so `createPaymentSession` makes no API call at all:
amount, currency, reference, capture method and the checkout fields are HMAC-signed into
`pspSessionId` and verified at `completePayment`. The browser round-trips the token (it is
also the session's `clientSecret`, which is how Adyen Web learns the amount) but cannot
tamper with it, and every context carries an **expiry** (`sessionTtlSeconds`, default 1h)
enforced at completion. `encodeSessionContext` / `decodeSessionContext` are exported for
advanced use.

## Webhooks

Verification requires **both** factors Adyen offers, because its HMAC covers only eight field
values (`pspReference`, `originalReference`, `merchantAccountCode`, `merchantReference`,
amount `value`/`currency`, `eventCode`, `success`):

- the **HMAC signature** in `additionalData.hmacSignature`, checked against the hex key(s)
  from the Customer Area, decoded to bytes as Adyen documents;
- the endpoint's **basic authentication** credentials, which authenticate the channel the
  unsigned remainder of the payload (`additionalData`, `reason`, `paymentMethod`, …) arrived
  on — hosts read those fields from `event.raw`.

The signature covers those eight values rather than the delivered bytes, so a payload that
was deserialized and re-serialized in transit still verifies — the adapter declares
`webhookSignatureScope: "field-values"` and behaves accordingly, because refusing a
re-encoded body would mean guessing Adyen's wire format and rejecting legitimate
deliveries. What that scope costs is covered by the credentials above and by treating every
unsigned field as untrusted input. A delivery whose signed values contain the `:` delimiter
is refused (Adyen documents no escaping rule, so the signed payload would be ambiguous), as
is one whose signed values were altered. `verifyAdyenWebhook` returns the specific reason;
`verifyWebhookSignature` is the boolean the contract asks for.

## What's inside

- **`AdyenServerAdapter`**, the full server contract (create session / complete, manual
  capture, cancel, refunds).
- **Webhook helpers**, `verifyAdyenWebhookSignature`, `verifyAdyenWebhook`,
  `parseAdyenWebhookEvent` (one event per delivery) and `parseAdyenWebhookEvents` (the
  defensive fan-out), plus `buildAdyenHmacPayload` and `mapAdyenEventType`.
- **`mapAdyenError` / `mapAdyenRefusal` / `mapAdyenResultCode`**, the taxonomy mapping —
  business rejections are never replayed, and an unrecognized refusal reason is still a
  decline.
- **`encodeAdyenPaymentRef` / `decodeAdyenPaymentRef`**, the composite payment reference.

## Notes

- Every call carries an `idempotency-key` derived deterministically from the caller's
  `idempotencyKey` **and the endpoint** (Adyen caps it at 64 characters, so it travels as a
  SHA-256 digest). Adyen stores keys at company-account level rather than per endpoint, so
  one caller key spanning `/payments` and `/payments/details` — the 3-D Secure flow — or a
  capture and a refund would otherwise be answered with the first call's stored response.
  The transport retries timeouts/5xx/429 with backoff (`maxNetworkRetries`, default 2) and
  replays a duplicate racing the in-flight original (`errorCode` 704).
- **`returnUrl` is required on every payment.** Pass it per session, or set
  `defaultReturnUrl` once; a session with neither is refused with `invalid_request` instead
  of reaching Adyen. A host `id` containing `:` or `\` is refused too: it becomes the
  `merchantReference` Adyen signs into every webhook, and the delimiter would make those
  signatures unverifiable.
- Manual capture is requested per payment (`additionalData.manualCapture`), so enabling it
  account-wide is not required. Multiple partial captures are off by default at Adyen and a
  single partial capture releases the remainder, so `supportsMultiCapture` is `false`.
- **CLP, CVE, IDR and ISK are rejected locally**: Adyen prices them with different fractional
  digits than ISO 4217 (PayFanout's minor-unit contract), so passing amounts through would
  shift the decimal point. The check runs on session creation *and* on the currency carried
  by a `pspPaymentId`, so a capture or refund for a payment created elsewhere is refused too.
- Card vaulting, zero-amount verification, session update, listing, and native subscriptions
  are out of scope for this version (declared `false`).

## Documentation

- [Set up Adyen](https://donapulse.github.io/payfanout/guide/adyen)
- [Server usage](https://donapulse.github.io/payfanout/guide/server)
- [Webhooks](https://donapulse.github.io/payfanout/guide/webhooks)
- [API reference](https://donapulse.github.io/payfanout/api/)

## License

MIT
