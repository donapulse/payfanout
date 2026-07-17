# @payfanout/adapter-paypal-server

Server-side PayPal adapter for [PayFanout](https://donapulse.github.io/payfanout/):
Orders v2 REST (create / capture / authorize), refunds, webhook verification via PayPal's
postback API, missed-webhook event polling, and Subscriptions v1 passthroughs
(list / retrieve / cancel).

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

## PSP-native subscriptions (Subscriptions v1)

The adapter passes PayPal's own billing product through as unified records —
`nativeSubscriptions: { list: true, retrieve: true, create: false, cancel: true }`:

- **`create` is honestly `false`.** `POST /v1/billing/subscriptions` answers
  `APPROVAL_PENDING` plus an `approve` link the buyer must act on; the API documents no
  server-only creation against a vaulted token (its only approval-free request shape takes
  a raw card number, which PayFanout never touches). Subscriptions are created in your
  PayPal-hosted flow; PayFanout lists, retrieves, and cancels them.
- **Recurring amount**: read from the effective plan's REGULAR billing cycle
  `pricing_scheme.fixed_price` (the detail GET carries `fields=plan` to expand it).
  Tier-priced plans have no fixed price, so the last collected payment amount is the
  fallback; a subscription reporting neither is rejected rather than given an invented
  amount. Taxes, shipping, and quantity multipliers stay on `raw`.
- **Statuses**: `APPROVAL_PENDING`/`APPROVED` → `pending`, `ACTIVE` → `active`,
  `SUSPENDED` → `paused`, `CANCELLED` → `canceled`, `EXPIRED` → `completed` (a finite
  schedule that ran its cycles), anything unrecognized → `unknown`.
- **Listing** pages by number (`page_size` 1–20); the opaque `nextCursor` is the next page
  number. List items omit the inline plan, so each page performs one `fields=plan` detail
  GET per item (≤ 20) on top of the list call. The unfiltered list returns PayPal's own
  default status set — the reference does not enumerate it.
- **Cancel** is verified-idempotent: the endpoint accepts only ACTIVE/SUSPENDED
  subscriptions and declares no `PayPal-Request-Id` channel, so on any cancel rejection
  the adapter re-fetches and treats an already-terminal subscription (CANCELLED/EXPIRED)
  as success. The required cancel `reason` is filled with a fixed factual default
  (`PAYPAL_SUBSCRIPTION_CANCEL_REASON`).

See the [PayPal set-up guide](https://donapulse.github.io/payfanout/guide/paypal) for
credentials, the two-step button UX, webhook registration, and the currency rules
(no 3-decimal currencies; HUF/TWD/JPY are whole-unit).

## License

MIT
