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
  // Worldline requires a 3-D Secure return URL on every card payment; sessions may override it.
  defaultReturnUrl: "https://your-shop.example/checkout/return",
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

The host id round-trips via `order.references.merchantReference` (`PaymentInfo.id`), and the
session's `metadata` via `order.references.merchantParameters`, sent JSON-encoded and echoed
by Worldline on reads and webhooks: `retrievePayment` reports it as `PaymentInfo.metadata`, and
`readWorldlineWebhookMetadata(event)` reads it from a webhook's payment. Worldline caps the
field at 1000 characters, so a session whose metadata, JSON-encoded, is longer is refused with
`invalid_request` before any call to Worldline, as is a metadata value that is not a string.
Worldline also says the field "must not contain any personal data": keep personal data out of
a Worldline session's metadata. The adapter cannot tell and sends what it is given.

## Authentication

Requests are signed with Worldline's **`v1HMAC`** scheme (`Authorization: GCS v1HMAC:{apiKeyId}:{signature}`)
using WebCrypto — no `node:crypto`, so the adapter stays edge-compatible. The `Date` header is
sent and signed (RFC-1123 GMT); Worldline rejects timestamps older than five minutes, so the
clock is an injectable `now()` seam. Every mutating call carries a signed, deterministic
`X-GCS-Idempotence-Key` derived from the caller's `idempotencyKey`.

## 3-D Secure

Worldline lists a set of 3-D Secure properties as mandatory on every card payment, and the
Hosted Tokenization Page requires at least those. Every CreatePayment the adapter sends
carries the ones it can supply:

- **The return URL, in both documented forms** — `cardPaymentMethodSpecificInput.returnUrl`
  and `cardPaymentMethodSpecificInput.threeDSecure.redirectionData.returnUrl`. It is required:
  pass `returnUrl` per session or set `defaultReturnUrl` once, absolute, with a scheme such as
  `https://` or an app scheme, at most 200 characters; a session with neither, or with a URL
  that breaks those rules, is refused with `invalid_request` before any call to Worldline. An
  empty `returnUrl` counts as none. **Set `defaultReturnUrl` before upgrading** from a release
  that did not require a return URL: sessions that release created without their own
  `returnUrl` carry none, and completing them is otherwise refused.
- **`threeDSecure.skipAuthentication: false`**, never the deprecated flat
  `cardPaymentMethodSpecificInput.skipAuthentication`.
- **The browser's device data** as `order.customer.device`. The client adapter's `confirm()`
  sends it with the `hostedTokenizationId` as a JSON `clientToken`,
  `{"hostedTokenizationId":"…","device":{…}}`, which `decodeWorldlineClientToken` reads back.
  Only the fields a browser can read are kept — `locale`, `timezoneOffsetUtcMinutes`,
  `userAgent` and `browserData` — and each is checked against Worldline's documented types and
  lengths; one that fails is dropped rather than failing the payment. `acceptHeader` and
  `ipAddress` (request headers your server observes) and `deviceFingerprint` (bound to a
  device-fingerprinting session) are defined by Worldline but refused from the browser, as is
  any key Worldline does not define. A bare `hostedTokenizationId` is still accepted and sends
  no device data.
- **`challengeIndicator: "challenge-required"`** when the session passes
  `sca: { challenge: "force" }`.
- **A contact detail for Visa**, which Worldline also requires: the adapter sends
  `order.customer.contactDetails.emailAddress` from the session's `receiptEmail` or
  `billingDetails.email`, so pass one of them.
- **The use case Cartes Bancaires requires**,
  `cardPaymentMethodSpecificInput.paymentProduct130SpecificInput.threeDSecure.usecase: "single-amount"`,
  on every payment whatever the card's brand, which the adapter does not learn before paying.
  Worldline's 3-D Secure guide writes `useCase`; the API contract and Worldline's Node SDK
  spell it `usecase`. The adapter neither stores cards nor charges them again, so each payment
  is a single amount.

The rest of the list does not come from this adapter:

- **The cardholder name** (`cardPaymentMethodSpecificInput.card.cardholderName`) is collected
  in the Hosted Tokenization iframe's name field, which Worldline hides unless the `Tokenizer`
  receives `hideCardholderName: false`; keep that field visible (see
  [`@payfanout/adapter-worldline`](../adapter-worldline)).
- **`order.customer.device.acceptHeader`** and, for Visa and Cartes Bancaires,
  **`order.customer.device.ipAddress`** come from the customer's HTTP request to your server,
  not from the browser, and neither `CompletePaymentInput` nor `createCompletionHandler`
  carries them to the adapter today, so the adapter cannot send them.

`sca: { exemption: "moto" }` sends `cardPaymentMethodSpecificInput.transactionChannel: "MOTO"`,
Worldline's channel for mail order and telephone order payments; without it no channel is
sent, and Worldline applies its `ECOMMERCE` default. The 3-D Secure data above is sent
unchanged on a MOTO payment: Worldline says its platform detects MOTO as outside the scope of
SCA, but not what it does with that data, so a MOTO payment it does not treat as excluded
still goes through 3-D Secure rather than skipping it. A challenge then comes back as
`requires_action`, and on a telephone order it would open in the browser the card was typed
into, not the cardholder's, so such a payment stays unfinished instead of being charged
without authentication. MOTO needs an acquirer and a Worldline account that allow it; run one
MOTO payment in the sandbox before relying on it.

Session creation also refuses, with `invalid_request` and before any call to Worldline, an
`id` longer than 40 characters (it travels as `order.references.merchantReference`) and a
`statementDescriptor` longer than 256 characters. The descriptor is sent as
`order.references.softDescriptor`, not the deprecated `descriptor`.

## What's inside

- **`WorldlineServerAdapter`**, the full server contract (create session / complete /
  retrieve, manual capture, cancel, refunds, refund polling).
- **Webhook helpers**, `verifyWorldlineWebhookSignature` and `parseWorldlineWebhookEvent`,
  operating on the **raw request bytes** and emitting a normalized `UnifiedWebhookEvent`. One
  event per delivery; a single-event array wrapper is unwrapped, and a multi-event batch is
  rejected rather than partially processed.
  The event `id` is `worldline:<type>:<payment id>` (the refund's id when there is no
  payment), built only from the pair Worldline documents as identical across duplicate
  deliveries, since any other field may differ on a redelivery and let a duplicate through.
  Payment-link events, `payment.test` messages and deliveries without the pair keep the
  envelope id. Worldline also warns: "The payment.id can change after each maintenance
  operation following an incremental logic. However, as this is not the case in some specific
  scenarios, we strongly recommend not building your business operations around it." So two
  events of one type on one payment id share an id, and a store keyed on it drops the second.
  On every verified refund-type delivery (`payment.refunded`, `payment.refund_failed`, and
  `unknown` events whose lower-cased `raw.type` starts with `refund.`), whether or not its id
  was already seen, re-read: `retrievePayment` for `amountRefunded`, `retrieveRefund` for your refunds
  still `pending` (both reads are idempotent). Also poll `retrieveRefund` until your refunds
  leave `pending`, reconcile captured payments with `retrievePayment` on a schedule, which
  catches operations made outside PayFanout (Worldline recommends a back-up GetPaymentDetails
  check), and never sum `event.amount` across refund events. Events after a maintenance
  operation (capture, refund, possibly cancellation) can report the operation's id as
  `pspPaymentId`. Correlation routes each cover part of them: `merchantReference`, sent only
  when `createPaymentSession` gets an `id`, shown echoed on sale events only and unverified on
  maintenance events; the refund id, the suffix of the composite `refundId` (below), for
  refunds made through `refundPayment` only; and `retrievePayment` with the original
  `pspPaymentId`. Parse no other id. Details:
  [Set up Worldline](https://donapulse.github.io/payfanout/guide/worldline), step 8.
- **`readWorldlineWebhookMetadata`**, the session metadata a parsed webhook's payment echoes,
  read by the rules `PaymentInfo.metadata` follows, since `UnifiedWebhookEvent` carries no
  metadata.
- **`mapWorldlineError`**, unifies Worldline errors into `PayFanoutError` (business rejections
  are never replayed), and **`WORLDLINE_PSP_NAME`**.
- **`buildV1HmacAuthorization`**, the request signer, exported for testing.

## Notes

- The transport retries timeouts/5xx/429 with backoff (`maxNetworkRetries`, default 2); every
  money-moving call is idempotent, so a replay can never double-charge.
- Worldline answers a repeated idempotency key with its first outcome for at least 24 hours,
  so a completion repeated after a failed attempt goes out again under a key derived from
  yours and that attempt: a stable per-order key still lets the customer pay with another
  card, and a completion repeated after a success returns that payment. A key carries at most
  20 attempts; [Set up Worldline](https://donapulse.github.io/payfanout/guide/worldline),
  step 7, lists the other limits.
- Worldline Direct has no refund-by-id endpoint, so `refundPayment` returns a **composite
  `refundId`** (`{paymentId}:{refundId}`) that `retrieveRefund` resolves through the payment's
  refund list. The part after the last `:` is Worldline's own refund id — the one webhooks
  report.
- Worldline Direct exposes no public events-list API (`supportsEventPolling: false`), so
  missed-webhook recovery falls back to `retrievePayment` per order.
- `PaymentInfo.createdAt` is the payment's `paymentOutput.transactionDate`, which Worldline
  describes as "the server-side processing date and time of the transaction"; a value without
  a zone is read as UTC. Whether a later capture or refund moves it is undocumented and not
  yet sandbox-verified, so keep your own record of when an order was placed. A payment that
  reports none, or one that is not a date, gets `1970-01-01T00:00:00.000Z`.
- Card vaulting, zero-amount verification, session update, and listing are out of scope for
  this version (declared `false`).
- A capture or cancellation the acquirer refuses leaves the payment authorised: it reads
  `requires_capture` and the authorisation stays in `amountCapturable`, ready to capture or
  cancel again. `capturePayment` reports the refusal only when Worldline answers it
  synchronously; Worldline documents a capture as `CAPTURE_REQUESTED` (status code 91) first,
  so the call usually resolves `processing` and the refusal (93) surfaces later, through
  `retrievePayment` or the `payment.rejected_capture` webhook, which parses as `unknown`.
- A refused capture can also leave an automatic-capture payment at `requires_capture`.
  `usePaymentStatus` from `@payfanout/react` does not treat that status as final and keeps
  polling, so stop it (`enabled: false`) when it arrives.
- `cancelPayment` resolves `processing` while the acquirer has not confirmed the cancellation
  (status codes 61/62); the `payment.cancelled` webhook, documented for status code 6, or a
  later `retrievePayment` settles it. Cancelling a payment Worldline reports as closed
  (already captured, for example) rejects with a non-retryable `invalid_request`, and
  repeating a cancellation that already took effect answers `canceled`. A 409 that persists
  while the payment is still cancellable stays a retryable `processing_error`, since an
  original under the same key may still be in flight; retry with the same `idempotencyKey`.
- A 409 on any call, Worldline's answer while the original request under the same key is
  still being processed, is retried, and one that outlives the retries rejects with a
  retryable `processing_error` marked `outcomeUnknown`: the original may still go through,
  so retry only under the same `idempotencyKey`.
- A refund the acquirer refuses leaves the payment `succeeded`: `retrieveRefund` reports the
  refund `failed` and it stays out of `amountRefunded`. Its `payment.rejected` webhook,
  carrying status code 73 or 83, arrives as `payment.refund_failed`; that reading follows
  Worldline's Statuses reference and is not yet sandbox-verified.
- Worldline documents the CapturePayment amount in cents with two assumed decimals, so a
  partial capture in a currency without two decimals (JPY, BHD, …) is refused with
  `invalid_request` and no capture request is sent. Capture the full authorised amount (it
  is sent without an amount) or cancel instead.

## Documentation

- [Set up Worldline](https://donapulse.github.io/payfanout/guide/worldline)
- [Server usage](https://donapulse.github.io/payfanout/guide/server)
- [Webhooks](https://donapulse.github.io/payfanout/guide/webhooks)
- [API reference](https://donapulse.github.io/payfanout/api/)

## License

MIT
