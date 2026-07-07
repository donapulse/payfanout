# Set up PayPal

PayPal is a **tokenize-first** PSP with a twist: there are no card fields at all. The
buyer clicks the **PayPal button**, approves in PayPal's popup, and your **server** then
captures the approved order. Like Paysafe, PayPal therefore needs a
**server-completion route** (step 7); unlike Paysafe, the "fields" your page renders are
PayPal's own button.

Two packages: [`@payfanout/adapter-paypal-server`](/guide/server) (holds the API secret;
**edge-runtime compatible**, fetch + WebCrypto only, runs on Cloudflare Workers /
Next.js edge) and [`@payfanout/adapter-paypal`](/guide/react) (browser-safe, holds only
the public client id).

## 1. Get your PayPal credentials

From the [PayPal developer dashboard](https://developer.paypal.com/dashboard/)
(Apps & Credentials → your REST app):

| Credential | What it is | Used by |
| --- | --- | --- |
| **Client ID** | Public REST app id — also what the browser SDK loads with | both adapters (`clientId`) |
| **Secret** | Authenticates the client id. Server-only | server adapter (`clientSecret`) |
| **Webhook ID** | Assigned when you register your listener URL (step 8) | server adapter (`webhookId`) |

Sandbox and live are **separate apps with separate credentials**; the adapter derives the
API host from `environment` (`sandbox → api-m.sandbox.paypal.com`,
`live → api-m.paypal.com`). You also need sandbox **test accounts** (dashboard →
Testing Tools → Sandbox Accounts): a business account backs your app, and you log into the
popup with a **personal** sandbox account to approve test payments.

## 2. Install

```bash
# server
pnpm add @payfanout/server @payfanout/adapter-paypal-server
# client (React)
pnpm add @payfanout/react @payfanout/adapter-paypal react react-dom
```

The PayPal JS SDK is **not** an npm dependency; the client adapter injects it lazily from
`www.paypal.com/sdk/js` on first mount (PayPal requires loading it from their host).

::: warning Not on npm yet
The packages are `0.1.0` and unpublished, consume from source per
[Installation](/guide/installation#using-it-now-from-source) until a release is cut.
:::

## 3. Environment variables

```bash
# .env (server), never committed
PAYPAL_CLIENT_ID=…
PAYPAL_CLIENT_SECRET=…
PAYPAL_WEBHOOK_ID=…               # from step 8; webhooks verify as false without it

# client bundle, must be VITE_-prefixed to reach the browser
VITE_PAYPAL_CLIENT_ID=…           # the same public client id
```

## 4. Wire the server adapter

```ts
import { PaymentService } from "@payfanout/server";
import { PayPalServerAdapter } from "@payfanout/adapter-paypal-server";

const paypal = new PayPalServerAdapter({
  clientId: process.env.PAYPAL_CLIENT_ID!,
  clientSecret: process.env.PAYPAL_CLIENT_SECRET!,
  environment: "sandbox",                    // → api-m.sandbox.paypal.com
  webhookId: process.env.PAYPAL_WEBHOOK_ID,  // required for webhook verification
  brandName: "Demo Shop",                    // optional: shown in the popup
});

const payments = new PaymentService({ adapters: [paypal] });
```

| Field | Required | Default | Notes |
| --- | --- | --- | --- |
| `clientId` / `clientSecret` | ✅ | - | REST app credentials. The secret is server-only. |
| `environment` | ✅ | - | Exactly `"sandbox"` or `"live"`; selects the API host. Never inferred. |
| `webhookId` | for webhooks | - | Without it `verifyWebhookSignature` answers `false` (fails closed). |
| `userAction` | - | `"CONTINUE"` | Popup button label. Keep `CONTINUE`: your own Pay button completes the payment. Must agree with the client adapter's `userAction`. |
| `returnUrl` / `cancelUrl` | - | - | Fallbacks when the session input carries none; `cancelUrl` defaults to the return URL. |
| `brandName` / `locale` | - | auto | Popup presentation. |
| `requestTimeoutMs` | - | `30000` | Abort a hung PayPal connection; surfaces as retryable `psp_unavailable`. |
| `maxNetworkRetries` | - | `2` | Retries transport trouble (network/timeout/5xx/429) only — retries reuse the same `PayPal-Request-Id`, so a capture can never double-charge. Business errors never retry. |

`createPaymentSession` creates a PayPal **order** (`intent: CAPTURE`, or `AUTHORIZE` for
`captureMethod: "manual"`); `pspSessionId` and `clientSecret` are both the order id.
OAuth tokens are minted and cached inside the adapter — nothing to configure.

## 5. Wire the client adapter

```tsx
import { PayFanoutProvider, PaymentFields } from "@payfanout/react";
import { PayPalClientAdapter } from "@payfanout/adapter-paypal";

const paypal = new PayPalClientAdapter({
  clientId: import.meta.env.VITE_PAYPAL_CLIENT_ID,  // public, browser-safe
  environment: "sandbox",
  currency: "USD",                                   // must match your sessions' currency
});
```

::: warning One currency (and intent) per page load
The PayPal JS SDK bakes `currency` and `intent` into its **script URL**, and the loaded
`window.paypal` global is a page-wide singleton — whichever adapter loads it first wins,
and later instances reuse it as-is. Multiple currencies, or mixing automatic and manual
capture, on the same page are therefore **not supported in v1**: a full page navigation
(or reload) is required between them. Manual-capture pages need `intent: "authorize"`;
a mismatch fails late, at approval time, with an SDK error.
:::

- `fieldOptions` passes through to `paypal.Buttons(...)` — use `style`
  (`layout`/`color`/`shape`/`label`/`height`) and `fundingSource`; `appearance` is the
  `style` fallback. The adapter owns only `createOrder`/`onApprove`/`onCancel`/`onError`
  (they are the integration itself).
- `locale` is a load-time SDK param — set it on the adapter config, not per mount.
- `userAction` is the client half of the server's `userAction`: `"continue"` (default)
  loads the SDK with `commit=false`, so the popup's final button says **Continue** and
  your Pay button does the capture; `"pay_now"` loads `commit=true` for
  capture-on-approval flows. **Both adapters must agree** — the popup's button promises
  what the server side then does.

::: tip Content-Security-Policy
The SDK loads from `www.paypal.com` and opens PayPal frames. If you set a CSP, allow
`*.paypal.com` and `*.paypalobjects.com` in `script-src`/`frame-src`/`connect-src`/`img-src`,
and check [PayPal's CSP page](https://developer.paypal.com/sdk/js/csp/) for the current list.
:::

## 6. The two-step UX: PayPal button approves, your Pay button pays

PayPal's popup can only be opened by PayPal's **own rendered button** (the click must
originate inside their iframe — a custom button cannot trigger it). PayFanout models this
as a two-step flow:

1. `<PaymentFields>` renders the **PayPal button**. The buyer clicks it, logs in, and
   approves in the popup — which says **"Continue"** (`userAction: "CONTINUE"`), because
   no money moves yet.
2. Approval fires `onChange({ complete: true })` — exactly the signal card adapters emit
   when fields become valid — so the same code that enables your Pay button for cards
   enables it for PayPal.
3. Your **Pay button** (`<PayButton>` / `usePay`) runs `confirm()`, which resolves
   immediately with the approved order id as `clientToken`, and hands it to your
   server-completion route. The server's `completePayment` **captures** — this is where
   money moves.

If the buyer closes the popup, the state resets (`complete: false`); they can simply click
the PayPal button again. If your Pay button somehow runs before approval, `confirm()`
waits for the popup outcome instead of failing.

## 7. The server-completion route

Identical to Paysafe's (PayPal is `requiresServerCompletion: true`):

```ts
// POST /api/complete  (your route)
app.post("/api/complete", express.json(), async (req, res) => {
  const info = await payments.completePayment("paypal", {
    pspSessionId: req.body.pspSessionId, // the order id from createPaymentSession
    clientToken: req.body.clientToken,   // the approved order id from confirm()
    idempotencyKey: req.body.orderId,    // required
  });
  res.json(info);
});
```

The adapter rejects a `clientToken` that names a different order than the session
(tamper guard), and branches on the order's intent: `CAPTURE` orders capture,
`AUTHORIZE` orders authorize and return `requires_capture` for a later
`capturePayment` (partial and multiple captures supported).

### Declines: `INSTRUMENT_DECLINED` recovery

When the buyer's funding source fails, capture rejects with `card_declined`
("The payment was declined — choose a different way to pay…"). The recovery is a fresh
approval **on the same order**: surface the error, the buyer clicks the PayPal button
again and picks another funding source in the popup, and your Pay button calls the
completion route again with the same order. No new session needed.

### Store the capture id

Once captured, `PaymentInfo.pspPaymentId` is the **capture id** (PayPal's "transaction
ID"), not the order id — persist it. PayPal's order GET stops answering a few days after
completion, while the capture id stays valid for refunds for 180 days.
`retrievePayment` accepts either id (it falls back from order to capture automatically).
Multi-capture payments are refunded **per capture id**: once an order carries more than
one capture, `refundPayment` rejects the order id and requires the specific capture id.

### `amountRefunded` caveat

PayPal's capture object carries no cumulative refunded total. `retrievePayment` reports
`amountRefunded` faithfully while the order GET (with its embedded refunds list) is alive,
and from a bare capture only the fully-`REFUNDED` case; a partially refunded old capture
reports `0`. Keep your own refund records — PayFanout's statelessness expects the host to
own payment bookkeeping anyway, and every `refundPayment` result carries the amounts.

## 8. Register the webhook endpoint

In the dashboard (your app → Webhooks) add your listener URL —
`https://your-api.example/webhooks/paypal` — subscribe at least to
`PAYMENT.CAPTURE.*` and `CUSTOMER.DISPUTE.*`, and copy the created webhook's **ID** into
`PAYPAL_WEBHOOK_ID`. Verification is a **postback**: the adapter POSTs the delivery
headers plus the raw body to PayPal's `verify-webhook-signature` endpoint and trusts only
`SUCCESS`. Without `webhookId` (or with any transmission header missing) it answers
`false` without a network call.

Mount the handler with the **raw body** — verification splices the exact delivered bytes
into the postback, so a parsed-and-re-serialized body fails by design:

```ts
import { createAdapterWebhookHandler } from "@payfanout/server";
const paypalHook = createAdapterWebhookHandler(paypal, {
  onEvent: (event) => enqueue(event), // ack-fast: enqueue, dedupe by event.id
});

app.post("/webhooks/paypal", express.raw({ type: "application/json" }), async (req, res) => {
  const r = await paypalHook({ rawBody: req.body.toString("utf8"), headers: req.headers });
  res.status(r.status).end();
});
app.use(express.json()); // AFTER the webhook route
```

::: warning The webhook simulator cannot pass verification
PayPal documents that **mock events from the simulator fail postback verification** by
design. To see a verified delivery end to end, make a real sandbox payment with a tunnel
(e.g. `cloudflared`/`ngrok`) pointed at your listener. PayPal retries failed deliveries up
to 25 times over 3 days.
:::

For missed events, the adapter supports polling: `fetchEvents({ since })` pages through
`GET /v1/notifications/webhooks-events` (~30 days of retention) and normalizes with the
same mapper as deliveries, so dedupe by `event.id` keeps working.

## 9. Currencies

PayPal checkout supports 25 currencies — and **no 3-decimal ones** (BHD, KWD, TND, …
are rejected locally with `invalid_request`):

AUD, BRL, CAD, CHF, CNY, CZK, DKK, EUR, GBP, HKD, HUF, ILS, JPY, MXN, MYR, NOK, NZD,
PHP, PLN, RUB, SEK, SGD, THB, TWD, USD.

BRL, CNY, and MYR are supported for **in-country PayPal accounts only** — a business
account registered elsewhere cannot charge them.

**Whole-unit rule:** PayPal accepts no decimals for **HUF, JPY, TWD**. JPY is 0-decimal in
ISO anyway, but HUF and TWD are ISO 2-decimal — their minor-unit amounts must be a
multiple of 100 (`HUF 105000` = 1050 Ft is fine, `HUF 1050` = 10.50 Ft is rejected
locally). Amounts stay integer minor units at every PayFanout boundary; the decimal
strings PayPal wants exist only inside the adapter.

## 10. Sandbox testing

- Approve popups by logging in with a **personal** sandbox account
  (sandbox.paypal.com uses the same credentials).
- **Negative testing:** enable it on the business sandbox account (Account → Settings →
  Negative Testing), then force errors per request with the
  `PayPal-Mock-Response: {"mock_application_codes": "INSTRUMENT_DECLINED"}` header —
  the integration suite has an env-gated case for this. Mock errors never work in live.
- Sandbox rate limiting kicks in around 50 requests/minute per IP; the adapter already
  maps 429 to a retryable `rate_limited`.

## 11. Limitations (v1)

- **No vaulting** (`supportsSavedPaymentMethods: false`): one-click repeat purchases via
  `payment_source.paypal.vault_id` and the v3 payment-tokens API are the documented
  future path.
- **No listing** (`supportsListing: false`): Orders/Payments v2 have no list endpoints;
  PayPal's Transaction Search API is a separate product.
- **No zero-amount verification** (`supportsPaymentMethodVerification: false`): there is
  no PayPal equivalent for wallet approvals.
- `cancelPayment` voids **authorizations** only. A CAPTURE-intent order cannot be
  cancelled via the API — stop using it and it expires on its own (~3 hours in the
  CREATED state).
- **Approval is popup-only.** On some mobile and in-app browsers the PayPal SDK falls
  back from the popup to a full-page redirect; the adapter implements no
  `handleRedirectReturn`, so in that fallback the buyer lands back on your `returnUrl`
  unhandled. The payment can still be completed: the buyer pays again (a fresh approval
  on the same order), or your server checks the order (`retrievePayment` — an approved
  order reports `requires_confirmation`) and calls the completion route.

## 12. Go live

- [ ] Swap in the **live** app's client id + secret; set `environment: "live"` on both
      adapters (host flips to `api-m.paypal.com`).
- [ ] Register the **live** webhook URL and use its **live** webhook ID.
- [ ] Confirm your live account's currencies match what you charge.
- [ ] Re-check the popup branding (`brandName`, `locale`) with a real account.
- [ ] Remember: no negative-testing header in live; declines are real declines.

Then continue with [Server usage](/guide/server), [React usage](/guide/react), and
[Webhooks](/guide/webhooks).
