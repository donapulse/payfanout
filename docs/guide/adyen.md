# Set up Adyen

Adyen is a **tokenize-first** PSP: the browser encrypts the card inside Adyen's hosted
fields, then your **server** creates the payment from that encrypted blob. It is also the
first **push-only** provider PayFanout ships:
[Adyen's Checkout API](https://docs.adyen.com/api-explorer/Checkout/72/overview) exposes no
read for a payment or a refund — only three of its endpoints are `GET` (payment links,
sessions, stored payment methods) and none is keyed by `pspReference` — and every
[capture](https://docs.adyen.com/online-payments/capture),
[cancel](https://docs.adyen.com/online-payments/cancel) and
[refund](https://docs.adyen.com/online-payments/refund) answers `{ "status": "received" }`,
with the real outcome arriving as a webhook. The adapter declares that honestly
(`supportsPaymentRetrieval: false`, `supportsRefundRetrieval: false`,
`modificationOutcome: "asynchronous"`) instead of inventing states, so **your webhook
endpoint is not optional here** — it is the only place outcomes exist.

Two packages: [`@payfanout/adapter-adyen-server`](/guide/server) (holds your API key;
**edge-runtime compatible**, WebCrypto only, runs on Cloudflare Workers / Next.js edge) and
[`@payfanout/adapter-adyen`](/guide/react) (browser-safe, holds only the public client key).

::: warning Validate against your own test account before going live
The provider-dependent facts in this adapter come from Adyen's documentation, not from test
traffic. The webhook signature is checked against Adyen's own published test vector, but the
adapter has not yet been exercised against an Adyen test account. Run one payment, one
3-D Secure 2 challenge, one capture, one refund and one webhook delivery through **your**
account before taking it to production, and check the results against
[§9](#_9-test-values); if Adyen routes a payment to its 3-D Secure redirect flow, check the
shopper's return to your `returnUrl` ([§6](#_6-3-d-secure)) as well. Account-specific
behaviour — enabled payment methods, the capture delay, whether multiple partial capture is
switched on, the exact `additionalData` your account returns — is only observable there.
:::

::: warning Adyen API details evolve
Endpoint hosts, Customer Area menu names, webhook event lists, and test values change over
time and vary per account. The **field names and behavior below are exact** (read from the
adapter source), but re-verify credential locations, test cards, and refusal triggers against
your own [Adyen documentation](https://docs.adyen.com) before going live.
:::

## 1. Get your Adyen credentials

Adyen keeps the server key and the browser key on the same credential record but generates
them separately — see
[API credentials](https://docs.adyen.com/development-resources/api-credentials) for the API
key and
[client-side authentication](https://docs.adyen.com/development-resources/client-side-authentication)
for the client key and its allowed origins.

From the **Adyen Customer Area** (Developers → API credentials, and Developers → Webhooks):

| Credential | What it is | Used by |
| --- | --- | --- |
| **API key** | The credential's key (Server settings → Authentication → API key), sent as `X-API-Key`; server-only, copy it when you generate it | server adapter (`apiKey`) |
| **Merchant account** | The merchant account name, as the account switcher in the Customer Area's upper-left corner shows it; case-sensitive | server adapter (`merchantAccount`) |
| **HMAC key** | Generated under **Security** on the webhook; a **hex** string, one per webhook endpoint | server adapter (`hmacKeys`) |
| **Webhook username + password** | Basic authentication on the webhook endpoint | server adapter (`webhookBasicAuth`) |
| **Live URL prefix** | Developers → API URLs → Prefix in the **live** Customer Area, for example `1797a841fbb37ca7-AdyenDemo`; **live only** | server adapter (`liveUrlPrefix`) |
| **Client key** | Public, browser-safe key (Client settings → Authentication → Client key), `test_…` or `live_…` | client adapter (`clientKey`) |

**Enable the Checkout encrypted cardholder data role.** Adyen requires it to accept the
encrypted card data the card fields produce, and it is not among the roles assigned by
default ([roles](https://docs.adyen.com/development-resources/api-credentials/roles)). Tick
it under **Permissions** on the credential. Any role your company's `ws` credential has can
be assigned there; if that credential lacks this one, the roles page says: "If you need
roles that your ws credential doesn't have, contact our Support Team." A credential missing
a required role gets Adyen error `010` "Not allowed"
([error codes](https://docs.adyen.com/development-resources/error-codes)). Live credentials
are configured separately, so enable it there again.

**Allowed origins** are set on the API credential: Adyen expects client-side requests only
from those domains. A test credential accepts `https` origins and the local secure contexts
`http://localhost`, `http://127.0.0.1` and `http://*.localhost`; live origins must be `https`.
An origin can include a wildcard: in Adyen's example, `https://*.example.org` includes both
`https://blue.example.org` and `https://red.example.org`.

**The live URL prefix** is a hex-encoded random part followed by your company name, one per
company account ([live endpoints](https://docs.adyen.com/development-resources/live-endpoints)).
Pass the prefix alone, not a URL; the adapter builds
`https://{liveUrlPrefix}-checkout-live.adyenpayments.com/checkout/{apiVersion}` from it.

**Rotating keys.** A new API key is active at once and the previous one keeps working for 24
hours; a replaced client key also expires after 24 hours. A new HMAC key takes some time to
propagate, so keep the previous key in `hmacKeys` next to the new one for a while
([secure webhooks](https://docs.adyen.com/development-resources/webhooks/secure-webhooks)).

Sandbox and live are **separate credential sets** and **separate hosts**; the adapter derives
the host from `environment` (`sandbox → checkout-test.adyen.com`,
`live → {liveUrlPrefix}-checkout-live.adyenpayments.com`).

Your own payment ids have one rule too: the `id` you pass to
`createPaymentSession` becomes Adyen's `merchantReference`, one of the values every webhook
signature covers. Adyen joins those values unescaped and the webhook verifier accepts a `:` in
`merchantReference`, but the adapter still keeps the references it creates free of `:` and
`\`, so an id containing either is refused — see
[Ids the adapter refuses](#ids-the-adapter-refuses).

::: danger One secret you generate yourself
`sessionSigningKey` is **not issued by Adyen.** Because PayFanout is stateless — and because
Adyen creates nothing at session time — the Adyen "session" is a **signed, self-contained
token**: amount, currency, reference, capture method and the checkout fields are HMAC-signed
into it so the browser can round-trip it but cannot tamper with the amount. That HMAC key is
**yours**. Generate a strong random secret once and keep it stable:

```bash
openssl rand -hex 32   # → ADYEN_SESSION_KEY
```

If it changes (or differs between server instances), previously issued sessions fail
signature verification at completion. The client adapter never needs this key.
:::

## 2. Install

```bash
# server
pnpm add @payfanout/server @payfanout/adapter-adyen-server
# client (React)
pnpm add @payfanout/react @payfanout/adapter-adyen react react-dom
```

Adyen Web is **not** an npm dependency; the client adapter injects the pinned build lazily
from Adyen's CDN on first mount.

## 3. Environment variables

```bash
# .env (server), never committed
ADYEN_API_KEY=…
ADYEN_MERCHANT_ACCOUNT=…
ADYEN_HMAC_KEY=…                  # hex, from the webhook's "Generate" button
ADYEN_WEBHOOK_USERNAME=…
ADYEN_WEBHOOK_PASSWORD=…
ADYEN_SESSION_KEY=…               # YOUR secret, openssl rand -hex 32 (not from Adyen)
ADYEN_LIVE_URL_PREFIX=…           # live only

# .env (client bundle)
VITE_ADYEN_CLIENT_KEY=test_…
```

## 4. Wire the server adapter

```ts
import { PaymentService } from "@payfanout/server";
import { AdyenServerAdapter } from "@payfanout/adapter-adyen-server";

const adyen = new AdyenServerAdapter({
  apiKey: process.env.ADYEN_API_KEY!,
  merchantAccount: process.env.ADYEN_MERCHANT_ACCOUNT!,
  environment: "sandbox",                            // → checkout-test.adyen.com
  sessionSigningKey: process.env.ADYEN_SESSION_KEY!, // YOUR HMAC secret, not an Adyen credential
  hmacKeys: [process.env.ADYEN_HMAC_KEY!],           // pass several to rotate with no cutover
  defaultReturnUrl: "https://your-shop.example/checkout/return", // required unless every session passes returnUrl
  webhookBasicAuth: {
    username: process.env.ADYEN_WEBHOOK_USERNAME!,
    password: process.env.ADYEN_WEBHOOK_PASSWORD!,
  },
});

const payments = new PaymentService({ adapters: [adyen] });
```

| Field | Required | Default | Notes |
| --- | --- | --- | --- |
| `apiKey` | ✅ | - | Checkout API key, sent as `X-API-Key`. Server-only. |
| `merchantAccount` | ✅ | - | Booked on every payment and modification. |
| `environment` | ✅ | - | Exactly `"sandbox"` or `"live"`; selects the API host. Never inferred. |
| `liveUrlPrefix` | live only | - | The account's live URL prefix. The constructor throws without it on live. |
| `apiVersion` | - | `"v72"` | Pinned Checkout version, part of the base URL. |
| `defaultReturnUrl` | ✅¹ | - | Where Adyen returns the shopper. ¹Required unless every session passes its own `returnUrl` — Adyen lists it among the required fields on `POST /payments`. |
| `sessionSigningKey` | ✅ | - | HMAC key for the stateless signed session. **You generate this.** Keep it stable. |
| `hmacKeys` | ✅ | - | Hex webhook HMAC key(s) from the Customer Area. |
| `webhookBasicAuth` | ✅ | - | `{ username, password }` as configured on the webhook. See §8. |
| `sessionTtlSeconds` | - | `3600` | How long a signed session stays completable (1h). Enforced at completion. |
| `requestTimeoutMs` | - | `30000` | Abort a hung Adyen connection; surfaces as a retryable `psp_unavailable`. |
| `maxNetworkRetries` | - | `2` | Retries transport trouble (network/timeout/5xx/429) only, never business errors like refusals. |

::: tip Every call is idempotent
Each request carries an `idempotency-key` derived deterministically from your
`idempotencyKey` **and the endpoint being called** (Adyen
[caps the header at 64 characters](https://docs.adyen.com/development-resources/api-idempotency),
so it travels as a SHA-256 digest). The endpoint is part of it because Adyen stores keys at
company-account level, not per endpoint: reusing one key across `/payments` and
`/payments/details` — which the 3-D Secure flow in §6 does — would otherwise replay the
first answer instead of finishing the payment. Replaying the *same* call with the same key
still deduplicates at Adyen. A duplicate racing the still in-flight original (Adyen
`errorCode` 704) is retried automatically; a refusal never is.
:::

### Currencies the adapter refuses

Adyen prices **CLP, CVE, IDR and ISK** with a different number of fractional digits than
ISO 4217, which is PayFanout's minor-unit contract — and Adyen documents
[its own table as leading](https://docs.adyen.com/development-resources/currency-codes) for
amounts in minor units. Passing minor units straight through
would shift the decimal point, so `createPaymentSession` rejects those four with
`invalid_request`. Everything else follows ISO 4217; JPY (0 decimals) and BHD (3 decimals)
round-trip normally. `capturePayment` and `refundPayment` apply the same rule to the
currency carried by the `pspPaymentId` you hand them, so a payment created outside
PayFanout cannot slip a mispriced modification through either.

### Ids the adapter refuses

The `id` you pass to `createPaymentSession` becomes Adyen's `merchantReference`, which comes
back as one of the eight values every webhook signature covers. Adyen joins those values with
the `:` delimiter and escapes nothing: its
[verification instructions](https://docs.adyen.com/development-resources/webhooks/secure-webhooks/verify-hmac-signatures)
name no escaping rule, and its own validators join the values as they are. A `:` in
`merchantReference` cannot change how the signed string splits, so the webhook verifier
accepts it there and refuses it in every other signed value (§8): deliveries for payments
created elsewhere on the same webhook endpoint verify even when their reference contains one.
`createPaymentSession` still rejects an id containing `:` or `\` with `invalid_request`, a
conservative choice: until the adapter has been exercised against a live Adyen test account,
the references it creates stay clear of both characters rather than depend on the delimiter
handling. Ids without them are unrestricted, up to Adyen's 80-character reference limit.

## 5. Wire the client adapter

```tsx
import { PayFanoutProvider, PaymentFields, PayButton } from "@payfanout/react";
import { AdyenClientAdapter } from "@payfanout/adapter-adyen";

const adyen = new AdyenClientAdapter({
  clientKey: import.meta.env.VITE_ADYEN_CLIENT_KEY,
  environment: "sandbox",
  countryCode: "NL",          // Adyen Web takes it on the checkout instance
});

<PayFanoutProvider adapters={[adyen]} initialPsp="adyen" completionEndpoint="/api/complete">
  <PaymentFields clientSecret={session.clientSecret} />
  {/* completionEndpoint finishes the tokenize-first flow automatically — no onServerCompletion. See §7. */}
  <PayButton onResult={(result) => showOutcome(result)}>Pay</PayButton>
</PayFanoutProvider>
```

- Card fields render inside **Adyen-hosted iframes** (SAQ A). The encrypted blob the
  component produces is the only card-shaped thing that reaches your page.
- The adapter owns two component options — `showPayButton: false` (your `<PayButton>` drives
  submission) and `onChange` (where the encrypted blob arrives). Everything else in
  `fieldOptions` passes through to Adyen untouched, and `appearance` becomes Adyen's `styles`
  object (`base`, `error`, `placeholder`, `validated`).
- `sdkVersion` pins the Adyen Web build the adapter loads; override `sdkUrl` /
  `stylesheetUrl` to self-host.

::: tip Content-Security-Policy
A CSP-enforcing page must allow Adyen, or the fields fail quietly. 3-D Secure 2 challenges
are harder: they load from the card **issuer's** domains, and Adyen documents that it cannot
list them all, so a strict policy can block the challenge. Adyen's recommended policy is on
its [script security](https://docs.adyen.com/development-resources/pci-dss-compliance-guide/script-security)
page, which says it does not apply "if you are eligible for Self-Assessment Questionnaire A
(SAQ A)", but the 3-D Secure constraint applies to any page that enforces a CSP. The
[native 3-D Secure 2](https://docs.adyen.com/online-payments/3d-secure/native-3ds2) guide
states it with no such condition: "A strict Content Security Policy (CSP) can prevent native
3D Secure 2 challenges from being loaded on your website, because loading the 3D Secure 2
interface requires adding more URLs to your CSP. Adyen does not maintain a list of all URLs."
Adyen's own alternative is its redirect flow (the native 3-D Secure 2 guide's Limitations row:
"You can use the redirect flow if you do not want to adjust your CSP"), but this adapter has
no setting that selects it, so a page that keeps a strict `frame-src` or `form-action` should
expect native challenges to fail.

Following Adyen's recommended policy, a page running this adapter needs:

```
script-src  https://*.adyen.com
style-src   https://*.adyen.com
frame-src   *
connect-src *
form-action *
img-src     *
```

- **`script-src`, `style-src`**: the adapter loads Adyen Web's `adyen.js` and `adyen.css`
  from Adyen's CDN. Adyen's sample policy lists `style-src` only for Cash App, which would
  block the stylesheet, so allow the Adyen host there too.
- **`frame-src`, `connect-src`, `form-action`, `img-src`**: the wildcard, as Adyen
  recommends. For frames it gives the reason above — issuer challenge pages it cannot
  list — and adds that its own iframes and the issuers' 3-D Secure iframes are sandboxed.

Adyen's sample also allows wallet and partner hosts in `script-src`; this adapter mounts
only the Card component, so it needs none of them. The onboarding descriptor
(`adyenOnboarding.csp`) lists `https://*.adyen.com` under `script` and `*` under `frame` and
`connect`; `style-src`, `form-action` and `img-src` have no descriptor field.
:::

## 6. 3-D Secure

Pass a `returnUrl` on `createPaymentSession` (or rely on `defaultReturnUrl` — Adyen requires
one on every payment either way). When Adyen answers with an `action`,
`completePayment` reports `requires_action` and preserves the action on `PaymentInfo.raw`.
A `threeDS2` action resolves **inline** — hand it back to the mounted fields and complete the
payment with the resulting token:

```tsx
// Server: completePayment reported requires_action and returned the action to the browser.
// Client: resolve it against the mounted fields, then complete again.
const { mountedRef } = usePayFanout();

async function resolveChallenge(action: Record<string, unknown>) {
  const handle = mountedRef.current!.handle;
  const next = await adyen.handleAction(handle, action);   // resolves the challenge in place
  if (next.status !== "requires_confirmation") return next.error;
  // next.clientToken carries { details, paymentData } — POST it to your completion
  // route exactly like the first one; the server sends it to /payments/details.
  await fetch("/api/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionRef: mountedRef.current!.sessionRef, clientToken: next.clientToken }),
  });
}
```

`handleAction` is Adyen-specific (the unified contract has no action step, because most PSPs
resolve challenges inside `confirm()`), and the second `completePayment` posts
`/payments/details` instead of `/payments`. Routing both calls through one completion
handler with one `idempotencyKey` is fine: the adapter scopes the key it sends to the
endpoint, so the second call is not answered with the first one's stored response. One
challenge runs at a time per mounted field set — calling `handleAction` again while one is
outstanding fails with `invalid_request` rather than abandoning the first caller's promise.

## 7. The server-completion route

When the client encrypts the card, the library POSTs the resulting `clientToken` (with the
session reference) to your `completionEndpoint`, where you mount `createCompletionHandler`:

```ts
import { createCompletionHandler } from "@payfanout/server";

// POST /api/complete
const complete = createCompletionHandler({
  resolveSession: async (sessionRef) => {
    const order = await db.orderByClientSecret(sessionRef); // your storage
    return { service: payments, pspName: "adyen", pspSessionId: order.pspSessionId, idempotencyKey: `complete-${order.id}` };
  },
});
```

Under the hood it calls `completePayment`, which verifies the session signature and expiry,
then creates the payment. Prefer to hand-write the route? Call `completePayment` directly,
both forms are in [Server usage](/guide/server#server-completion-tokenize-first).

::: warning Store the whole `pspPaymentId`
Adyen has no payment read, so a capture or refund cannot look the amount and currency up.
The adapter therefore returns `pspPaymentId` as the composite
`"{pspReference}:{value}:{currency}"` and needs it back for `capturePayment` and
`refundPayment`. `cancelPayment` accepts a bare `pspReference`, and the part before the first
`:` is Adyen's own reference — the one webhooks report.

That composite is **server-side state**: it carries an amount, so read it from your own
record of the payment and never from a client request body — a browser that can choose the
`pspPaymentId` can choose how much you refund. When you cancel from a bare `pspReference`,
the returned `PaymentInfo` has `amount: 0` and `currency: "XXX"` (ISO 4217's "no currency"),
because no money facts travel on a bare reference; take the figures you show a shopper from
your own record, never from that response.
:::

## 8. Register the webhook endpoint

In **Developers → Webhooks**, create a *Standard webhook* and configure it as follows
([Adyen's configuration guide](https://docs.adyen.com/development-resources/webhooks/configure-and-manage)):

| Setting | What to choose |
| --- | --- |
| **URL** | `https://your-api.example/webhooks/adyen` |
| **Method** | **JSON**. The other two methods, HTTP POST and SOAP, send bodies that are not JSON, and every such delivery fails verification (`malformed_payload`). |
| **Encryption protocol** | TLSv1.2 or TLSv1.3. |
| **Merchant accounts** | A company-level webhook, which Adyen recommends, delivers every merchant account's events unless you include or exclude specific accounts. Include the ones this endpoint serves, or check `merchantAccountCode` (a signed value) before acting on an event. |
| **Basic authentication** | A username and password, passed as `webhookBasicAuth`. |
| **HMAC key** | Generate one and pass it as `hmacKeys`. |
| **Events** | Adyen always sends the default event codes. Select **`OFFER_CLOSED`**, which is not a default, and make sure every dispute event is selected, as Adyen's dispute guide asks. `adyenOnboarding.webhook.events` lists every code the adapter maps. |
| **Additional settings → Risk** | Enable **Include the originalReference for CHARGEBACK_REVERSED events**. Without it, `CHARGEBACK_REVERSED`, `SECOND_CHARGEBACK`, `PREARBITRATION_WON` and `PREARBITRATION_LOST` carry no `originalReference`, and the adapter falls back to their own `pspReference` as `pspPaymentId`, a reading Adyen implies but does not state (see [What each event becomes](#what-each-event-becomes)). |

Adyen requires an HTTPS endpoint with TLSv1.2 or TLSv1.3, on port 443, 8443 or 8843. For test
webhooks its requirements also list plain HTTP on port 80, 8080 or 8888: don't use it, because
basic authentication needs HTTPS ("otherwise your basic authentication credentials can be
compromised").

The adapter requires both security settings:

- the HMAC key authenticates the
  [eight signed fields](https://docs.adyen.com/development-resources/webhooks/secure-webhooks/verify-hmac-signatures)
  (`pspReference`, `originalReference`, `merchantAccountCode`, `merchantReference`, amount
  `value` and `currency`, `eventCode`, `success`);
- basic authentication authenticates the channel the *rest* of the payload arrived on —
  Adyen's HMAC does not cover it, and hosts read those fields from `event.raw`.

::: warning Basic authentication, not OAuth
Adyen
[strongly recommends **OAuth 2.0**](https://docs.adyen.com/development-resources/webhooks/secure-webhooks)
for standard webhooks and supports basic authentication for all webhook types. This adapter
verifies the basic-auth
credentials, and only those: an endpoint configured for OAuth sends a bearer token the
adapter cannot check, so **every delivery fails verification**
(`verifyAdyenWebhook` reports `credential_mismatch`, or `missing_credentials` when the
header is absent entirely). Configure the endpoint with basic authentication, or terminate
OAuth in front of PayFanout and give the adapter its own credentials.
:::

Mount the handler with the **raw body**:

```ts
import { createAdapterWebhookHandler } from "@payfanout/server";
const adyenHook = createAdapterWebhookHandler(adyen, {
  onEvent: (event) => enqueue(event), // ack-fast: enqueue, upsert by event.id (below); never process inline
});

app.post("/webhooks/adyen", express.raw({ type: "application/json" }), async (req, res) => {
  const r = await adyenHook({ rawBody: req.body.toString("utf8"), headers: req.headers });
  res.status(r.status).end();
});
app.use(express.json()); // AFTER the webhook route
```

The handler answers `200` with an empty body once `onEvent` returns. Adyen accepts a successful (2xx) status
[within 10 seconds](https://docs.adyen.com/development-resources/webhooks/handle-webhook-events);
past that it marks the webhook as failing and retries, which is why `onEvent` should only
enqueue.

### What each event becomes

A JSON delivery
[carries exactly one notification item](https://docs.adyen.com/development-resources/webhooks/webhook-types).
`success` and `live` are the **strings** `"true"`/`"false"`, never booleans — the adapter
compares the exact string, and so should any code you write against `event.raw`; any other
`success` value maps to `unknown`.

| `eventCode` | `success: "true"` | `success: "false"` |
| --- | --- | --- |
| `AUTHORISATION` | `payment.succeeded`¹ | `payment.failed` |
| `CAPTURE` | `payment.succeeded` | `unknown`² |
| `CAPTURE_FAILED` | `payment.failed`³ | `payment.failed` |
| `CANCELLATION`, `TECHNICAL_CANCEL` | `payment.canceled` | `unknown`² |
| `EXPIRE`⁴, `OFFER_CLOSED` | `payment.canceled` | `payment.canceled` |
| `REFUND` | `payment.refunded`⁵ | `payment.refund_failed` |
| `REFUND_FAILED`, `REFUNDED_REVERSED` | `payment.refund_failed` | `payment.refund_failed` |
| `NOTIFICATION_OF_CHARGEBACK`, `CHARGEBACK` | `payment.chargeback` | `payment.chargeback` |
| `CHARGEBACK_REVERSED` | `payment.chargeback_won`⁶ | `payment.chargeback_won` |
| `ISSUER_RESPONSE_TIMEFRAME_EXPIRED`, `PREARBITRATION_WON`, `SCHEME_ARBITRATION_WON` | `payment.chargeback_won` | `payment.chargeback_won` |
| `SECOND_CHARGEBACK`, `PREARBITRATION_LOST`, `SCHEME_ARBITRATION_LOST`, `DISPUTE_DEFENSE_PERIOD_ENDED` | `payment.chargeback_lost` | `payment.chargeback_lost` |
| `CANCEL_OR_REFUND`⁷ and every other code | `unknown` | `unknown` |

1. Under manual capture, `AUTHORISATION` means *authorised*: the funds are held, not taken,
   until the `CAPTURE` event. By default, automatic captures send no `CAPTURE` event.
2. The request was refused, not the payment: Adyen's guidance is to review `reason`, fix the
   issue and resubmit. To spot one, look for `type: "unknown"` with `raw.eventCode` `CAPTURE`,
   `CANCELLATION` or `TECHNICAL_CANCEL` and `raw.success` `"false"`, then read `raw.reason`,
   which the signature does not cover.
3. Not always final: Adyen re-captures technical failures within 10 business days, and a
   re-capture arrives as a `CAPTURE` whose `reason` is `Transaction Recaptured` or
   `Transaction Auto-recaptured`.
4. Adyen's [webhook reference](https://docs.adyen.com/api-explorer/Webhooks/latest/post/EXPIRE)
   describes `EXPIRE` as "The remaining uncaptured amount expired", with the amount originally
   authorised. The adapter declares `supportsMultiCapture: false`, and by default Adyen cancels
   whatever a partial capture leaves over. On an account with multiple partial captures enabled
   that remainder stays open, so a payment captured in part can later expire and read
   `payment.canceled` although money moved: after a successful `CAPTURE`, an `EXPIRE` ends only
   the uncaptured remainder.
5. Not final either: `REFUND_FAILED` or `REFUNDED_REVERSED` can still follow it.
6. Adyen documents this stage as not final: a later `payment.chargeback_lost` overrides it.
7. A reversal states the operation Adyen performed only in
   `additionalData["modification.action"]`, which the signature does not cover, so it is not
   reported as a cancel or a refund. Codes Adyen adds later arrive as `unknown` too.

`event.pspPaymentId` is the payment's reference: the event's `originalReference` whenever it
carries one, and otherwise its own `pspReference` on `AUTHORISATION`, `EXPIRE` and
`OFFER_CLOSED`. `CHARGEBACK_REVERSED`, `SECOND_CHARGEBACK`, `PREARBITRATION_WON` and
`PREARBITRATION_LOST` carry `originalReference` only with the Risk setting above, and without
it the adapter reports their own `pspReference`. Adyen's
[dispute webhooks page](https://docs.adyen.com/risk-management/disputes-api/dispute-notifications)
describes the setting as returning "the PSP reference of the payment in the
`originalReference` field, and the PSP reference of the dispute in the `pspReference`", which
implies the payment's reference sits in `pspReference` until you enable it, but no page states
it. Adyen documents every `pspReference` as globally unique, so if that reading is wrong your
lookup finds no payment rather than the wrong one: treat such a miss as a sign to enable the
setting. Any other event without `originalReference`, such as a capture or a report
notification (its `pspReference` is a file name), has no `pspPaymentId`. Refund events keep
their own `pspReference` as `event.refundId`.

### Duplicates and ordering

Adyen [defines duplicates](https://docs.adyen.com/development-resources/webhooks/handle-webhook-events)
as deliveries with "the same values in the `eventCode` and `pspReference` fields, while the
`eventDate` and other fields can be different", and adds: "Your server should use the details
from the latest webhook event." `event.id` is exactly that pair,
`"{eventCode}:{pspReference}"`, so upsert on it instead of dropping a repeat: keep the delivery
with the latest `occurredAt` (its `eventDate`). A `pspReference` alone does not identify an
event: `CAPTURE` and `CAPTURE_FAILED` both carry the capture request's, `REFUND` and
`REFUND_FAILED` the refund's, `AUTHORISATION`, `EXPIRE` and `OFFER_CLOSED` the payment's, and
every event of one dispute the dispute's, so the `eventCode` is what keeps them apart. Two
deliveries of one kind for one dispute are duplicates by Adyen's definition, and the upsert
keeps the latest.

Deliveries arrive in no guaranteed order, and there is no payment read to settle the
sequence, so apply a payment's events in `occurredAt` order, as Adyen asks ("To ensure you are
processing events in the correct chronological order, always check the timestamp"): that is
how a later `payment.chargeback_lost` replaces an earlier `payment.chargeback_won`. Three
rules refine that order:

- **`occurredAt` is only as good as `eventDate`.** It comes from `eventDate`, which the
  signature does not cover, so it can be relied on only because basic authentication
  authenticates the channel it arrived on. An `occurredAt` of `1970-01-01T00:00:00.000Z` means
  the time is unknown: the delivery's `eventDate` was missing or did not parse, and the adapter
  reports the epoch rather than a time it made up. Don't let such an event reorder the others.
- **A final dispute stage outranks a later date.** An outcome that Adyen's
  [dispute flow](https://docs.adyen.com/risk-management/understanding-disputes/dispute-process-and-flow)
  makes final is never overridden by a non-final one, whatever the dates say:
  `SECOND_CHARGEBACK` ("This is the final stage"), `SCHEME_ARBITRATION_WON` ("The dispute is
  closed"), `SCHEME_ARBITRATION_LOST` (Adyen follows it with that final second chargeback),
  `DISPUTE_DEFENSE_PERIOD_ENDED` (a chargeback accepted or not defended in time, which the page
  calls the final stage), `ISSUER_RESPONSE_TIMEFRAME_EXPIRED` (a defense the issuer accepted or
  did not answer in time, likewise final) and `PREARBITRATION_WON` ("the final status can be
  `Won` if the issuing bank accepts the defense in pre-arbitration"). `CHARGEBACK_REVERSED`
  "is not final", so it never replaces any of them. `PREARBITRATION_LOST` is not on the list:
  the page marks it lost without calling it final.
- **`payment.chargeback_lost` is a state, not a sum.** A lost scheme arbitration arrives twice,
  as `SCHEME_ARBITRATION_LOST` and then as the second chargeback that Adyen says "will include
  the scheme arbitration fees on top of the dispute amount". Record the dispute as lost once,
  and never add `event.amount` up across dispute events.

### What the signature covers

Adyen's signature covers **eight extracted values, not the delivered bytes**, so a body a
middleware deserialized and re-serialized still verifies — by design, and the adapter
declares it as `webhookSignatureScope: "field-values"`. Refusing such a body would mean
guessing Adyen's wire format, and a wrong guess rejects every legitimate delivery. Three
consequences land on your handler:

- **Basic authentication is what authenticates the caller.** A signature over values proves
  the values came from Adyen, never who posted them — hence the credential requirement above.
- **Everything outside those eight fields arrives unauthenticated**, including everything you
  read from `event.raw`. Treat `additionalData`, `reason`, `paymentMethod` and `eventDate` as
  untrusted input.
- **Signed values keep the types Adyen's webhook schema gives them.** The signature covers the
  values joined as strings, so a delivery whose signed values have another type (a boolean
  `success`, a string amount) or lack a required one fails verification as
  `malformed_payload` instead of being coerced; only a `null` `originalReference` or
  `merchantReference`, the two optional values, reads as absent, since that is how Adyen's own
  validators sign it. Adyen joins the values with `:` and escapes nothing, so a `:` in any
  signed value except `merchantReference` fails as `ambiguous_signed_value`; in
  `merchantReference` it cannot change how the string splits.

Keep the raw body all the way to the handler anyway: it costs nothing, and it is what every
other PSP's verification hashes.

Adyen exposes no events-polling API (`supportsEventPolling: false`), and there is no
`retrievePayment` to reconcile against, so treat the webhook queue as the system of record:
persist every event, upsert by `event.id`, and alert on gaps.

## 9. Test values

[Adyen's test cards](https://docs.adyen.com/development-resources/test-cards-and-credentials/test-card-numbers)
work on its test platform only — for example Visa `4111 1111 1111 1111` and Mastercard
`5555 5555 5555 4444`, both expiry `03/2030`, CVC `737`.

**3-D Secure 2.** Adyen's
[3-D Secure 2 testing page](https://docs.adyen.com/development-resources/testing/3d-secure-2-authentication)
lists the enrolled cards, among them Mastercard `5454 5454 5454 5454` and Visa
`4917 6100 0000 0000` (`03/2030`, `737`). Its challenge scenario uses Visa
`4212 3456 7891 0006` and its frictionless scenario Mastercard `5201 2815 0512 9736`, both
`03/2030`, `737`. Answer a browser challenge with the password `password`; any other value
fails the authentication. If your test account's Dynamic 3D Secure default rule is
**Prefer Not**, set it to **Always** while testing so these cards trigger 3-D Secure.

**Refusals are triggered by the cardholder name, not the card number.** Adyen reads the
trigger from `paymentMethod.holderName` or `additionalData.RequestedTestAcquirerResponseCode`
([testing result codes](https://docs.adyen.com/development-resources/testing/result-codes)).
This adapter never sends the second, so type the trigger into the Card's cardholder-name
field, with any test card above. If the Card shows no cardholder-name field, enable it with
`fieldOptions: { hasHolderName: true }`.

| Cardholder name | Adyen `refusalReason` | `completePayment` rejects with |
| --- | --- | --- |
| `DECLINED` | Refused | `card_declined` |
| `CARD_EXPIRED` | Expired Card | `expired_card` |
| `NOT_ENOUGH_BALANCE` | Not enough balance | `insufficient_funds` |
| `CVC_DECLINED` | CVC Declined | `invalid_card_data` |
| `ISSUER_UNAVAILABLE` | Issuer Unavailable | `processing_error` |

For the failure webhooks, a payment made with the name `capture failed` gets
`CAPTURE_FAILED` on its capture, and one made with `refund failed` gets `REFUND_FAILED` on
its refund; Adyen notes the simulation can take up to 24 hours
([testing payments and modifications](https://docs.adyen.com/development-resources/testing/payments-and-modifications)).
Confirm the current values on Adyen's pages before relying on them.

## 10. Go live

Adyen does not copy settings from your test Customer Area to the live one
([go-live checklist](https://docs.adyen.com/online-payments/go-live-checklist)): everything
you configured in test is configured again in the **live** Customer Area.

- [ ] Generate a **live** API key and enable the **Checkout encrypted cardholder data** role
      on its credential ([§1](#_1-get-your-adyen-credentials)).
- [ ] Swap in the **live** merchant account, set `environment: "live"` on **both** adapters,
      and add `liveUrlPrefix` on the server one, from Developers → API URLs → Prefix
      ([live endpoints](https://docs.adyen.com/development-resources/live-endpoints)).
- [ ] Generate the **live** client key (`live_…`) and add your production origins to its
      credential; live origins must be `https`.
- [ ] Check that the live merchant account's **Capture delay** (Settings → Account settings →
      General) is **immediate**, Adyen's default. The adapter sends no capture parameter for
      `captureMethod: "automatic"`, so that setting decides when the money is taken; a
      manual-capture payment carries `additionalData.manualCapture`, which overrides it
      ([capture](https://docs.adyen.com/online-payments/capture)).
- [ ] Add the card brands you accept to the live account.
- [ ] Register the **live** webhook with HMAC **and** basic authentication. Its HMAC key is new
      and differs from the test key, and live endpoints must be HTTPS on port 443, 8443 or
      8843. Send a test delivery from the live Customer Area and check it reaches your queue
      ([configure webhooks](https://docs.adyen.com/development-resources/webhooks/configure-and-manage)).
- [ ] If you read `additionalData` from `raw`, give the live account the same additional-data
      settings for API responses and webhooks as the test one.
- [ ] Allow for Mastercard 3-D Secure enrollment, which can take up to 12 hours after the live
      Customer Area is activated.
- [ ] Complete PCI DSS **SAQ A**, the document Adyen requires for this kind of integration,
      and have an approved scanning vendor scan the page that loads Adyen's components every
      quarter and after significant changes
      ([PCI DSS compliance](https://docs.adyen.com/online-payments/pci-dss-compliance),
      [vulnerability scanning](https://docs.adyen.com/development-resources/pci-dss-compliance-guide/vulnerability-scanning-regulation)).
- [ ] Keep `ADYEN_SESSION_KEY` stable and secret in production; rotating it invalidates
      in-flight sessions.
- [ ] Verify card fields are still Adyen's hosted iframes (SAQ A), no raw card input.
- [ ] Re-check endpoint paths, [event codes](https://docs.adyen.com/development-resources/webhooks/webhook-types),
      [result codes](https://docs.adyen.com/online-payments/build-your-integration/payment-result-codes)
      and [refusal reason codes](https://docs.adyen.com/development-resources/refusal-reasons)
      against the current Adyen documentation.
- [ ] Once the live account is configured, test end to end with real payment details, which
      incur fees. Adyen's
      [end-to-end testing](https://docs.adyen.com/online-payments/go-live-checklist#end-to-end-testing)
      list includes a successful payment, a payment with `resultCode` **Refused** (for example
      by entering incorrect card details), a refund and a partial refund, and a 3-D Secure
      payment where the shopper fails to complete the challenge.

Then continue with [Server usage](/guide/server), [React usage](/guide/react), and
[Webhooks](/guide/webhooks).
