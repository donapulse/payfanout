# @payfanout/adapter-payzen-server

Server-side PayZen (Lyra) adapter for [PayFanout](https://donapulse.github.io/payfanout/):
payments, validation capture, refunds, and IPN verification over the PayZen REST API V4.

> **Holds secrets.** This package uses your PayZen REST password. Never bundle it
> client-side.

It implements the `ServerPaymentAdapter` contract from `@payfanout/core`, so
`@payfanout/server` drives it through the same unified API as every other PSP. It talks to
the REST API directly and is **edge-runtime compatible** (WebCrypto only, no Node builtins),
so it runs on Cloudflare Workers and Next.js edge routes.

📖 **Documentation:** <https://donapulse.github.io/payfanout/>
· [Set up PayZen](https://donapulse.github.io/payfanout/guide/payzen)
· [Server usage](https://donapulse.github.io/payfanout/guide/server)

## Installation

```bash
pnpm add @payfanout/server @payfanout/adapter-payzen-server
```

`@payfanout/core` comes in transitively.

## Usage

```ts
import { PaymentService } from "@payfanout/server";
import { PayZenServerAdapter } from "@payfanout/adapter-payzen-server";

const payzen = new PayZenServerAdapter({
  shopId: process.env.PAYZEN_SHOP_ID!,       // Back Office "User"
  password: process.env.PAYZEN_PASSWORD!,    // testpassword_… / prodpassword_…
  environment: "sandbox",                    // validated against the key family
  hmacKey: process.env.PAYZEN_HMAC_KEY,      // browser-return kr-answer validation
});

const payments = new PaymentService({ adapters: [payzen] });
```

This is a **confirm-on-client** PSP: `createPaymentSession` returns a short-lived
`formToken` as `clientSecret`, the krypton-client form in the browser creates the
transaction (3DS2 inline), and the server reads outcomes via `retrievePayment` and the
IPN. There is no `completePayment` step.

## What's inside

- **`PayZenServerAdapter`** — sessions (`Charge/CreatePayment`), reads
  (`Transaction/Get`, `Order/Get`), manual capture via `Transaction/Validate`,
  cancel/refund (`Transaction/Cancel`, `Transaction/Refund`,
  `Transaction/CancelOrRefund`), PSP-native subscriptions
  (`Charge/CreateSubscription`, `Subscription/Get`, `Subscription/Cancel`), and IPN
  signature verification (HMAC-SHA-256 over the raw `kr-answer`, both key families,
  rotation arrays).
- **Synthesized idempotency** — PayZen has no idempotency mechanism, so the adapter
  derives a deterministic `orderId` from your `idempotencyKey`, stamps it into
  transaction metadata, and never auto-retries refund-class calls. See the
  [PayZen guide](https://donapulse.github.io/payfanout/guide/payzen) for the residual
  caveats (never blind-retry refunds).
- Errors normalize into PayFanout's taxonomy — PayZen answers HTTP 200 even for
  failures, so the envelope (`INT_`/`PSP_`/`ACQ_`/`AUTH_` codes) drives the mapping and
  the untouched envelope always rides `raw`.

## PSP-native subscriptions

Capability: `nativeSubscriptions: { list: false, retrieve: true, create: true, cancel: true }`.
The gateway itself schedules, charges, and retries every installment against a vaulted
`paymentMethodToken`; installment outcomes arrive as ordinary transaction IPNs on the
existing webhook path (enable the Back Office rule "Notification URL when creating a
recurring payment").

> **PayZen has no subscription list or search API (`list: false`), and `Subscription/Get`
> / `Subscription/Cancel` require BOTH `subscriptionId` and the `paymentMethodToken` —
> they form a composite key. Store both, durably, for every subscription you create or
> adopt: neither can be rediscovered through the API.**

- **Create** (`createNativeSubscription`) — `interval`/`intervalCount` synthesize an
  RFC 5545 RRULE (`day`, `week`, `month`, `year` are all accepted; PayZen rejects only
  sub-daily periods), or pass a richer rule via `schedule`. `startAt` maps to the
  required `effectDate` ("now" when omitted; SEPA mandates must start at least 14 days
  out). `merchantRefNum` rides PayZen's dedicated `orderId` field. `planId` is rejected
  (PayZen has no plan model) and `pspCustomerId` is withheld (subscriptions key on the
  token).
- **Replay caveat** — creation applies immediately and PayZen offers no idempotency
  channel: a replayed create can mint a second live subscription. The adapter therefore
  never auto-retries creation, derives a deterministic `orderId` from your
  `idempotencyKey`, and stamps `payfanout_key` into metadata so duplicates stay
  traceable in the Back Office and on installment IPNs — but never blind-retry
  `createNativeSubscription`; reconcile first.
- **Status is derived** — the `V4/Subscription` object has no status field. The adapter
  reports, first match wins: `cancelDate` set → `canceled`; finite schedule
  (`totalPaymentsNumber > 0`) with `pastPaymentsNumber` caught up → `completed`;
  `effectDate` in the future → `pending`; otherwise `active`. The record's `schedule`
  carries the gateway's rrule verbatim; `interval`/`intervalCount` appear only when the
  rrule is a faithful simple cadence (`FREQ` + `INTERVAL` + optional `COUNT`).
- **Cancel is verified-idempotent** — `Subscription/Cancel` answers a bare response code
  (0 terminated, 30 token not found, 32 subscription not found, 99 undefined error), so
  the returned record comes from a follow-up `Subscription/Get`. On any rejection the
  adapter re-reads the subscription and resolves successfully when it is already
  terminated — replaying a cancel is always safe. Cancellation does not touch
  installments already in flight; cancel those individual transactions if needed.

Pair it in the browser with [`@payfanout/adapter-payzen`](../adapter-payzen), which mounts
the embedded card form the `formToken` feeds.

## Documentation

- [Set up PayZen](https://donapulse.github.io/payfanout/guide/payzen)
- [Server usage](https://donapulse.github.io/payfanout/guide/server)
- [Webhooks](https://donapulse.github.io/payfanout/guide/webhooks)
- [API reference](https://donapulse.github.io/payfanout/api/)

## License

MIT
