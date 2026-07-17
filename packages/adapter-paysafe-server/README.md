# @payfanout/adapter-paysafe-server

Server-side Paysafe adapter for [PayFanout](https://donapulse.github.io/payfanout/):
Payment Handles, Payments, Settlements, Refunds, Webhooks, and Payment Scheduler
subscriptions, over the Paysafe REST APIs.

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
  charging, native subscriptions).
- **Webhook helpers**, `verifyPaysafeWebhookSignature` and `parsePaysafeWebhookEvent`,
  operating on the **raw request bytes** and emitting a normalized `UnifiedWebhookEvent`.
  Paysafe retries webhooks effectively forever until it sees a 2xx.
- **`mapPaysafeError`**, unifies Paysafe errors into `PayFanoutError` (business errors like
  declines or `3406` are never replayed), and **`PAYSAFE_PSP_NAME`**.

## PSP-native subscriptions (Payment Scheduler)

The adapter declares `nativeSubscriptions: { list, retrieve, create, cancel }` all true,
backed by Paysafe's Payment Scheduler (`subscriptionsplans/v1`, same hosts and the same
Basic API key as the Payments API — the docs' "Back Office" is where that key is
retrieved, not a separate credential).

- **Create** bills an already-vaulted **MULTI_USE token** (`savePaymentMethod`'s output;
  the scheduler rejects single-use Paysafe.js tokens). Subscriptions attach to a plan:
  pass `planId` to bill from a plan you manage (the input amount/currency/cadence must
  match it — mismatches reject instead of silently billing different terms), or omit it
  and the adapter creates a dedicated open-ended plan from the input inline.
- **Cadence** is `day`/`month`/`year` (+ `intervalCount` 1-365). The scheduler has no
  weekly frequency and no RRULE input — `interval: "week"` and any `schedule` reject
  with `invalid_request` rather than approximating.
- **Idempotency** rides `merchantRefNum` ("unique for this accountId"):
  `input.merchantRefNum` wins when supplied, `idempotencyKey` fills it otherwise, and a
  replayed create recovers the existing subscription by that refNum. A transport-retried
  inline plan creation can leave an orphan plan (plans carry no refNum); the
  subscription itself stays exactly-once, so nothing double-bills.
- **Cancel** PATCHes the final `CANCELLED` status (never the reversible `SUSPENDED`) and
  is verified-idempotent: on a rejection the adapter re-reads the subscription and
  treats `CANCELLED`/`COMPLETED` as success.
- **Status mapping:** `ACTIVE` → `active`, `CANCELLED` → `canceled`, `SUSPENDED` →
  `paused`, `COMPLETED` → `completed`; anything else on the wire → `unknown`.
- `pspCustomerId` and `metadata` have no scheduler channel and are withheld; the
  customer profile derives from the vaulted token.

## Notes

- The Paysafe transport retries timeouts/5xx/429 with backoff (`maxNetworkRetries`,
  default 2).
- Paysafe has no public events API (`supportsEventPolling: false`), so missed-webhook
  recovery falls back to `retrievePayment` per order.
- Scheduler availability is per merchant account, like every Paysafe product option —
  the capability flags state what the adapter implements; an account without the
  scheduler answers with its own rejection.

## Documentation

- [Set up Paysafe](https://donapulse.github.io/payfanout/guide/paysafe)
- [Server usage](https://donapulse.github.io/payfanout/guide/server)
- [Webhooks](https://donapulse.github.io/payfanout/guide/webhooks)
- [API reference](https://donapulse.github.io/payfanout/api/)

## License

MIT
