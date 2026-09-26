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
| `brandName` / `locale` | - | auto | Popup presentation; `brandName` takes at most 127 characters on one line (checked at construction; an empty one is omitted). |
| `requestTimeoutMs` | - | `30000` | Abort a hung PayPal connection; surfaces as retryable `psp_unavailable`. |
| `maxNetworkRetries` | - | `2` | Retries transport trouble (network/timeout/5xx/429) only — retries reuse the same `PayPal-Request-Id`, so a capture can never double-charge. Business errors never retry. |

`createPaymentSession` creates a PayPal **order** (`intent: CAPTURE`, or `AUTHORIZE` for
`captureMethod: "manual"`); `pspSessionId` and `clientSecret` are both the order id. The
session `id` travels as the order's `custom_id`, so it takes at most 255 characters, and
amounts must be greater than zero; both are refused as `invalid_request` before any call.
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
- A button render that fails, and anything the buttons deliver through `onError`, surface
  as `processing_error` with the SDK's error on `raw`. The `onError` ones are **not
  retryable**: PayPal's [JS SDK reference](https://developer.paypal.com/sdk/js/v5/reference#onerror)
  documents that callback as a catch-all with nothing to handle beyond a generic error
  message or page. A failed render is retryable, since mounting again can succeed. PayPal's
  SDK hands a failed render to `onError` and then rejects it; the adapter reports it once,
  as the retryable render failure `mount()` rejects with. Any other error PayPal reports
  while the buttons render is reported once too, before `onReady` when the render
  succeeds. A host `onError` or `onReady` that throws after a successful render does not
  remove the buttons: its exception is reported as uncaught.
- `locale` is a load-time SDK param — set it on the adapter config, not per mount.
- `userAction` is the client half of the server's `userAction`: `"continue"` (default)
  loads the SDK with `commit=false`, so the popup's final button says **Continue** and
  your Pay button does the capture; `"pay_now"` loads `commit=true` for
  capture-on-approval flows. **Both adapters must agree** — the popup's button promises
  what the server side then does.

::: tip Content-Security-Policy
The SDK loads from `www.paypal.com` and opens PayPal frames. PayPal's
[CSP recommendation](https://developer.paypal.com/sdk/js/v5/best-practices) for a page
running the JS SDK is:

```
script-src  *.paypal.com *.paypalobjects.com *.venmo.com 'unsafe-inline'
style-src   *.paypal.com *.paypalobjects.com *.venmo.com 'unsafe-inline'
connect-src *.paypal.com *.paypalobjects.com *.venmo.com
frame-src   *.paypal.com *.paypalobjects.com *.venmo.com
child-src   *.paypal.com *.paypalobjects.com *.venmo.com
img-src     *.paypal.com *.paypalobjects.com *.venmo.com data:
```

PayPal calls a nonce safer than `'unsafe-inline'`: it replaces `'unsafe-inline'` with
`'nonce-<value>'` in `script-src` and `style-src` and puts the same value in the SDK tag's
`nonce` and `data-csp-nonce` attributes. Pass that value as `cspNonce` and the adapter sets
both attributes on the tag it injects. PayPal also recommends
`Cross-Origin-Opener-Policy: same-origin-allow-popups` on a page running the SDK. The
onboarding descriptor (`paypalOnboarding.csp`) lists these hosts under `script`, `frame`
and `connect`; `style-src`, `child-src` and `img-src` have no descriptor field.

**Nonce-based policies.** The adapter never reads a nonce from the page: pass the one your
server put in the page's policy. Under PayPal's policy the hosts in `script-src` already
allow the SDK tag, as `'strict-dynamic'` would, since the adapter creates it, so the tag's
`nonce` matters only for a `script-src` that allows scripts by nonce alone. What changes the
outcome is `data-csp-nonce`: the SDK reads only that attribute and sets its value on the
inline scripts and styles it creates, which PayPal's policy blocks otherwise. That
attribute also puts the nonce back within reach of CSS attribute selectors: under a
header-delivered policy a browser hides a connected element's `nonce` attribute from them,
but not a `data-` one. PayPal requires it, so the adapter sets it on PayPal's tag alone.
Keep PayPal's hosts in `script-src`: some of the SDK's own loads, such as the Messages
modal's `modal.js`, carry no nonce. Write the source quoted, `'nonce-<value>'`: PayPal's
examples leave the quotes out, and a browser does not read that form as a nonce. An SDK the
page loaded itself is used as it is, so give its tag both attributes yourself. PayPal's
nonce policy puts the nonce in `style-src`, which turns `'unsafe-inline'` off there: on a
page that can mount other PSPs as well, read
[Content-Security-Policy on a page with several PSPs](/guide/providers#content-security-policy-on-a-page-with-several-psps)
first.
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

Identical to Paysafe's (PayPal is `requiresServerCompletion: true`): set
`completionEndpoint` on the provider and mount `createCompletionHandler` at it —

```ts
import { createCompletionHandler } from "@payfanout/server";

// POST /api/complete
const complete = createCompletionHandler({
  resolveSession: async (sessionRef) => {
    const order = await db.orderByClientSecret(sessionRef); // your storage
    return { service: payments, pspName: "paypal", pspSessionId: order.pspSessionId, idempotencyKey: `complete-${order.id}` };
  },
});
```

Under the hood it calls `completePayment` (which **captures**). The adapter rejects a
`clientToken` that names a different order than the session (tamper guard), and branches on
the order's intent: `CAPTURE` orders capture, `AUTHORIZE` orders authorize and return
`requires_capture` for a later `capturePayment` (partial and multiple captures supported,
see [Manual capture](#manual-capture-partial-captures-and-the-rest) below).
Prefer a hand-written route? Call `completePayment` directly — see
[Server usage](/guide/server#server-completion-tokenize-first).

### Completing an order twice

A second `completePayment` for an order that is already captured or authorized (a double
click, or a retry under a fresh idempotency key) meets PayPal's `ORDER_ALREADY_CAPTURED` or
`ORDER_ALREADY_AUTHORIZED`. For the first, PayPal's guidance is to read the order to get the
capture; for the second, it says the funds are authorized and ready to capture. Either way
the adapter re-reads the order and returns the existing capture or authorization; no money
moves twice. It does so only when the order read back is the session's own order and
`COMPLETED` with that capture or authorization; otherwise the `invalid_request` stands. A
re-read that fails surfaces its own error instead, so an outage reaches you as a retryable
`psp_unavailable`.

A repeated completion succeeds under any key, so `onCompleted` can run more than once for
one payment; hosts should make it idempotent on `info.pspPaymentId` and check `info.id` and
`info.amount` against their own record.

A `409` from PayPal (the Payments API documents `RESOURCE_CONFLICT` with
`PREVIOUS_REQUEST_IN_PROGRESS` on captures, voids and refunds) rejects with a retryable
`processing_error` marked `outcomeUnknown: true`: the request still in progress can be your
call's own first one under the same `PayPal-Request-Id`, which PayPal processes while it
"might fail the second request". Retry under the same idempotency key, never a new one.

### Declines: `INSTRUMENT_DECLINED` recovery

When the buyer's funding source fails, capture rejects with `card_declined`
("The payment was declined — choose a different way to pay…"). The recovery is a fresh
approval **on the same order**: surface the error, the buyer clicks the PayPal button
again and picks another funding source in the popup, and your Pay button calls the
completion route again with the same order. No new session needed.

When PayPal's refusal is not about one funding source (`PAYMENT_DENIED`,
`PAYER_CANNOT_PAY`, `PAYER_ACCOUNT_RESTRICTED`, `PAYER_ACCOUNT_LOCKED_OR_CLOSED`,
`MAX_NUMBER_OF_PAYMENT_ATTEMPTS_EXCEEDED`), the error is still `card_declined`, but the
message asks for another payment method ("PayPal declined this payment — choose another
payment method."): offer the buyer a different way to pay, not the PayPal button again.
Both kinds share the code and differ only in `message`, which `localizeError` replaces
outside English, so a UI that branches on the code should keep your other payment methods
on offer next to the PayPal button after any PayPal `card_declined`.
`TRANSACTION_BLOCKED_BY_PAYEE` (your own fraud protection settings) is `fraud_suspected`,
and `TRANSACTION_RECEIVING_LIMIT_EXCEEDED` (your account's receiving limit) is
`processing_error`.

### Store the capture id

Once captured, `PaymentInfo.pspPaymentId` is the **capture id** (PayPal's "transaction
ID"), not the order id — persist it. PayPal's order GET stops answering a few days after
completion, while the capture id stays valid for refunds for 180 days.
`retrievePayment`, `capturePayment`, and `cancelPayment` accept either id: a capture id
resolves to its order through the capture's `supplementary_data.related_ids.order_id`.
After further captures `pspPaymentId` stays the first capture's id, so the id you stored
keeps working for the next capture and for reads.
Multi-capture payments are refunded **per capture id**: once an order carries more than
one capture, `refundPayment` rejects the order id and requires the specific capture id.

### Manual capture: partial captures and the rest

`capturePayment(id, amount, key)` captures `amount` and keeps the authorization open for
another capture while money is left; each partial capture needs its own idempotency key.
PayPal requires partial capture of PayPal authorizations to be enabled on your PayPal
account. Without an amount it captures **the rest**. PayPal reads a capture without an
amount as the *full authorized amount*, so the adapter sends the uncaptured remainder
explicitly: the authorized amount minus every capture that took money, completed or
pending (declined and failed captures took nothing).

The capture that takes the rest, with or without an explicit amount, goes out with
`final_capture: true` (on an estimate after a reauthorization, only once it takes
everything the order has left, see below),
which closes the authorization: PayPal refuses any further capture against it
(`AUTHORIZATION_ALREADY_CAPTURED`). Once earlier captures took the whole
authorization (PayPal reports it `CAPTURED`, a capture that took money went out as the
final one, or those captures cover the authorized amount) or the whole order amount,
capturing the rest sends no capture and answers with the payment, under the same key or a
new one. A retry you issue yourself of a capture of the rest whose response was lost
therefore gets the payment back rather than an error. An authorization voided or denied
before captures took it all (PayPal reports an expired authorization as voided) has nothing
left to take: capturing the rest rejects with `invalid_request` before any capture call.

PayPal lets captures exceed the authorized amount up to the account's overage limit (by
default up to 115% of the authorized amount or USD 75 more, whichever is less; PSD2
countries allow none). The adapter passes an explicit amount through for PayPal to judge
and never adds an overage itself. Authorizations last 29 days, and captures succeed best
within the first three days. A remainder you will not capture is left to expire;
`cancelPayment` voids only an authorization with no capture yet.

If you reauthorize through PayPal (the adapter never does), PayPal creates a new
authorization, with its own id, beside the original, and its guides send later captures to
the new one. The adapter then captures and reports against the newest authorization by
`create_time` (one reporting none counts as the oldest) and then list order, unless it was
denied; an older one counts as superseded whatever status it still reports. PayPal's pages
disagree on whether an authorization can be reauthorized more than once, and the adapter
reads any number.

`cancelPayment` still voids the original, the oldest authorization: PayPal refuses to void
a reauthorization (`CANNOT_BE_VOIDED`, "Please void the original parent authorization"),
although its reauthorization example shows a `void` link on the new one. PayPal does not
say what either authorization reports once the original is voided, so `cancelPayment`
returns what the order read shows. If the original already reads `VOIDED` next to a
reauthorization that still holds the funds, the void fails with PayPal's refusal rather
than a `canceled` the adapter cannot confirm.

The rest to capture is what the newest authorization holds less the captures taken from
it, and never more than the order amount less every capture that took money: a
reauthorization with an empty body holds "the full amount" again, so the new authorization
alone could take past the order. `amountCapturable` reports the same figure. An order read
that reports no amount is measured by the original authorization, which holds the order
amount; a reauthorization can hold up to 115% of it, so when neither reports an amount,
capturing the rest of a reauthorization needs an explicit amount.

A capture belongs to the authorization PayPal ties it to (`related_ids.authorization_id` or
the capture's `up` link), but PayPal's order read documents no such tie. A capture that
names none counts against every authorization created no later than it, by `create_time`,
so a capture taken before the reauthorization leaves the new authorization whole. A missing
`create_time`, on the capture or on an authorization, rules nothing out, which errs low. If
such a capture could have come from either authorization, the rest is an estimate:
capturing it goes out with
`final_capture: false`, so the authorization stays open for whatever the estimate missed,
which you can take with an explicit amount, also once the estimate reaches zero and
capturing the rest answers with the payment. Only a capture of everything the order has
left closes it then. Once an estimate reaches zero, `PaymentInfo` no longer shows what is
left (`amount` then equals `amountCaptured`): compare `raw.purchase_units[0].amount` with
`amountCaptured`. What you never capture is left to expire, as `cancelPayment` voids
only an authorization with no capture yet. An explicit amount still goes to PayPal as it
is, for PayPal to judge against its overage limit.

After a reauthorization, a `payment.canceled` event (PayPal's
`PAYMENT.AUTHORIZATION.VOIDED`) may concern the original rather than the authorization
holding the funds: PayPal documents that event for a void or an expiry and says nothing of
reauthorizations. The event's `pspPaymentId` is the order id when the event carries
`related_ids.order_id`, as PayPal's example does, and `raw.resource.id` is the voided
authorization, so re-read the payment with `retrievePayment` before you treat it as
canceled.

### `amountRefunded` caveat

PayPal's capture object carries no cumulative refunded total. `retrievePayment` reports
`amountRefunded` from the order's embedded refunds list while the order GET is alive, and
from a bare capture only the fully-`REFUNDED` case; a partially refunded old capture
reports `0`. From the list it counts `COMPLETED` refunds and `PENDING` ones (that money is
on its way back, so it is never offered for refund again) and leaves out `FAILED` and
`CANCELLED` refunds, which returned nothing. Keep your own refund records — PayFanout's
statelessness expects the host to own payment bookkeeping anyway, and every
`refundPayment` result carries the amounts.

`refundPayment` does not forward `reason`. PayPal's only reason field, `note_to_payer`, is
text the payer reads in their transaction history and in PayPal's emails, and a code such
as `requested_by_customer` is not a message for a customer.

### Payment method details

`paymentMethodDetails.wallet` is `"venmo"` for an order paid with Venmo
(`payment_source.venmo`) and `"paypal"` otherwise; a guest card payment adds the card's
`brand` and `last4`. A bare capture, read once its order has aged out, carries no payment
source, so `paymentMethodDetails` is left out rather than naming a wallet it cannot
confirm.

## 8. Register the webhook endpoint

In the dashboard (your app → Webhooks) add your listener URL —
`https://your-api.example/webhooks/paypal` — subscribe it to the events the adapter maps
(the list is `paypalOnboarding.webhook.events`; PayPal documents only `*`, every event
type, as a wildcard), and copy the created webhook's **ID** into `PAYPAL_WEBHOOK_ID`.
Verification is a **postback**: the adapter POSTs the delivery headers plus the raw body
to PayPal's `verify-webhook-signature` endpoint and trusts only `SUCCESS`. Without
`webhookId`, with any transmission header missing, or with a body that is not exactly one
JSON object, it answers `false` without a network call.

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
`GET /v1/notifications/webhooks-events` and normalizes with the same mapper as
deliveries, so dedupe by `event.id` keeps working. PayPal documents no retention period
for that list; its events dashboard searches only the last 30 days.

## 9. Currencies

PayPal checkout supports the currencies of its
[currency codes reference](https://developer.paypal.com/reference/currency-codes) — and
**no 3-decimal ones** (BHD, KWD, TND, … are refused locally: `unsupported_operation`
through `PaymentService`, `invalid_request` from the adapter itself):

AUD, BRL, CAD, CHF, CNY, CZK, DKK, EUR, GBP, HKD, HUF, ILS, JPY, MXN, MYR, NOK, NZD,
PHP, PLN, SEK, SGD, THB, TWD, USD.

RUB is no longer on that list: a new session in RUB is refused locally, while payments
made in RUB earlier can still be retrieved, captured and refunded.

BRL, CNY, and MYR are payment or settlement currencies for **in-country PayPal accounts
only**: for an account based outside the country, PayPal converts the money into the
account's primary currency at its conversion rate, which includes a spread or fee.

A payment in a currency your PayPal account does not hold stays pending until you accept
it in your PayPal account, unless your Payment Receiving Preferences handle it
automatically; the adapter reports such a capture as `processing`.

**Whole-unit rule:** PayPal accepts no decimals for **HUF, JPY, TWD**. JPY is 0-decimal in
ISO anyway, but HUF and TWD are ISO 2-decimal — their minor-unit amounts must be a
multiple of 100 (`HUF 105000` = 1050 Ft is fine, `HUF 1050` = 10.50 Ft is rejected
locally). Amounts stay integer minor units at every PayFanout boundary; the decimal
strings PayPal wants exist only inside the adapter.

## 10. Sandbox testing

- Approve popups by logging in with a **personal** sandbox account
  (sandbox.paypal.com uses the same credentials).
- **Negative testing** (a sandbox beta): turn on Negative Testing on the **business**
  sandbox account your REST app belongs to (developer dashboard → Sandbox → Accounts →
  View/Edit Account → Settings), then force errors per request with the
  `PayPal-Mock-Response: {"mock_application_codes": "INSTRUMENT_DECLINED"}` header. PayPal's
  [request-headers page](https://developer.paypal.com/negative-testing/request-headers)
  describes the header alone as enough for REST calls, while its
  [negative-testing overview](https://developer.paypal.com/negative-testing/overview) has
  you turn the setting on first; doing both covers either reading. The header works on the Orders v2 create, update, show, authorize and capture
  calls, and on the Payments v2 show, capture and void authorization, show capture, refund
  capture and show refund calls (reauthorize is not listed). The integration suite has an
  env-gated case for this. Mock errors never work in live.
- PayPal [publishes no rate-limit policy](https://developer.paypal.com/api/rest/reference/rate-limiting):
  it may temporarily throttle traffic that looks abusive, answering `429` with
  `RATE_LIMIT_REACHED`, which the adapter maps to a retryable `rate_limited`. PayPal
  recommends webhooks over polling and cached OAuth tokens. The adapter caches its token
  per instance, so reuse one adapter rather than building one per request.

## 11. Limitations (v1)

- **No vaulting** (`supportsSavedPaymentMethods: false`): one-click repeat purchases via
  `payment_source.paypal.vault_id` and the v3 payment-tokens API are the documented
  future path.
- **No listing** (`supportsListing: false`): Orders/Payments v2 have no list endpoints;
  PayPal's Transaction Search API is a separate product.
- **No zero-amount verification** (`supportsPaymentMethodVerification: false`): there is
  no PayPal equivalent for wallet approvals.
- **Order updates** (`updatePaymentSession`) patch only what PayPal's patch table lists. A
  statement descriptor can be replaced but not added, so pass `statementDescriptor` when
  creating the session. It is cut to 22 characters, as PayPal does, and the card statement
  itself shows only 22 characters in total, starting with PayPal's `PAYPAL *` prefix and
  your merchant descriptor (PayPal's example: with the merchant descriptor `Janes Gift`,
  the descriptor `800-123-1234` shows as `PAYPAL * Janes Gift 80`). An address added by an
  update to an order created without shipping is not locked: the order keeps PayPal's
  default shipping preference (`GET_FROM_FILE`, the address the buyer picks on PayPal's
  site), which is set at creation and cannot be patched; only sessions created with
  shipping get `SET_PROVIDED_ADDRESS`.
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
