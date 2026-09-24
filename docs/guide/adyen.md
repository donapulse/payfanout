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
Every provider-dependent fact in this adapter is verified against Adyen's current
documentation, and the webhook signature is checked against Adyen's own published test
vector — but the adapter has not yet been exercised against a live Adyen test account.
Run one payment, one capture, one refund and one webhook delivery through **your** account
before taking it to production, and check the results against §9. Account-specific
behaviour — enabled payment methods, whether multiple partial capture is switched on, the
exact `additionalData` your account returns — is only observable there.
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
| **API key** | Checkout API key, sent as `X-API-Key` (server-only) | server adapter (`apiKey`) |
| **Merchant account** | The account every request is booked against | server adapter (`merchantAccount`) |
| **HMAC key** | Generated per webhook; a **hex** string that signs deliveries | server adapter (`hmacKeys`) |
| **Webhook username + password** | Basic authentication on the webhook endpoint | server adapter (`webhookBasicAuth`) |
| **Live URL prefix** | The account's live prefix; **live only** | server adapter (`liveUrlPrefix`) |
| **Client key** | Public, browser-safe key; its origins are allowlisted in the Customer Area | client adapter (`clientKey`) |

Sandbox and live are **separate credential sets** and **separate hosts**; the adapter derives
the host from `environment` (`sandbox → checkout-test.adyen.com`,
`live → {liveUrlPrefix}-checkout-live.adyenpayments.com`).

Your own payment ids matter as much as the credentials: the `id` you pass to
`createPaymentSession` becomes Adyen's `merchantReference` and is one of the values every
webhook signature covers, so it must not contain `:` or `\` — see
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
back as one of the eight values every webhook signature covers — and Adyen documents no
escaping rule for a signed value containing the `:` delimiter. An id like `order:1234` would
therefore verify no webhook for that payment, ever, and for a push-only PSP that is total
silent failure *after* the shopper has paid. So `createPaymentSession` rejects an id
containing `:` or `\` with `invalid_request`, at integration time. Ids without those two
characters are unrestricted, up to Adyen's 80-character reference limit.

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
- The cardholder name field is **shown and required by default** (`hasHolderName: true`,
  `holderNameRequired: true`): Adyen's
  [native 3-D Secure 2 guide](https://docs.adyen.com/online-payments/3d-secure/native-3ds2)
  requires the name for Visa and JCB, and Adyen Web hides the field unless told otherwise.
  Set `hasHolderName: false` in `fieldOptions` to hide it; Adyen Web then drops the
  requirement as well.
- Set `billingAddressRequired: true` in `fieldOptions` for better 3-D Secure 2 data. Adyen's
  `/payments` reference lists the billing address as required for 3-D Secure 2 in browser
  integrations, and its
  [3-D Secure API reference](https://docs.adyen.com/online-payments/3d-secure/api-reference)
  as recommended. The Card then includes the address in its state, and the server adapter
  forwards it when it is complete and within Adyen's limits (`street`, `houseNumberOrName`,
  `postalCode`, `city` and `country` all present), dropping it otherwise.
- The Card recognizes Mastercard, Visa and American Express (`['mc','visa','amex']`) unless
  told otherwise, and the adapter does not load your account's payment-method list — pass
  `brands` in `fieldOptions` to accept other brands
  ([Card Component options](https://docs.adyen.com/payment-methods/cards/web-component)).
- Pressing **Enter** in the fields does nothing by default. Adyen Web's own handler submits
  the Card, which has no `onSubmit` to call here; pass `onEnterKeyPressed` in `fieldOptions`
  to run your own pay action instead.
- `sdkVersion` pins the Adyen Web build the adapter loads; override `sdkUrl` /
  `stylesheetUrl` to self-host.

::: tip Content-Security-Policy
A CSP-enforcing page must allow Adyen, or the fields fail quietly. Adyen's own guidance is
the wildcard, because 3-D Secure and wallet frames are served from several hosts:

```
script-src  https://*.adyen.com
frame-src   https://*.adyen.com
connect-src https://*.adyen.com
```
:::

## 6. 3-D Secure

Adyen decides per payment whether 3-D Secure 2 runs **natively**, inside the mounted fields,
or through a **redirect** to Adyen. The adapter asks for the native flow and supports both.

`confirm()` resolves a JSON `clientToken` holding the `paymentMethod`, `browserInfo`,
`origin`, `billingAddress` and `riskData` of Adyen Web's state. The server adapter reads those
keys and nothing else — the signed session stays the only source of amount, currency,
reference, merchant account and capture method. It refuses a `paymentMethod` that is not a
card (`type: "scheme"`) or that carries unencrypted card fields, and forwards only the card
fields Adyen Web's Card produces: `type`, the `encrypted…` values, `holderName`, `brand`,
`fundingSource`, `fastlaneData`, `checkoutAttemptId` and `sdkData` (the native guide lists
the Card's complete `paymentMethod`, `sdkData` included, as required). With `browserInfo`
and the page's bare `origin` (scheme, host and port, no path, at most 80 characters),
`/payments` carries what the
[native 3-D Secure 2 guide](https://docs.adyen.com/online-payments/3d-secure/native-3ds2)
requires on the web: `channel: "Web"`, `origin`, `browserInfo` and
`authenticationData.threeDSRequestData.nativeThreeDS: "preferred"`. Any other `origin` is
dropped, and with it `channel` and `nativeThreeDS`, because Adyen documents that a missing or
wrong origin keeps the 3-D Secure 2 action from being handled; that the payment then takes
the redirect flow is an unverified inference (see [Redirect fallback](#redirect-fallback)).

`shopperEmail` is the session's `receiptEmail`, or its `billingDetails.email` when there is
none; a `billingDetails.email` that is not a usable address is left out rather than failing
the session. Pass an email, because Adyen's documentation disagrees on `shopperIP`: the
[v72 `/payments` reference](https://docs.adyen.com/api-explorer/Checkout/72/post/payments)
requires it for Visa and JCB 3-D Secure 2 web payments only when no `shopperEmail` is sent,
while the [3-D Secure API reference](https://docs.adyen.com/online-payments/3d-secure/api-reference)
and the native and redirect guides list it as required for Visa and JCB on the web. The
adapter sends none either way — PayFanout's session and completion inputs carry no shopper
IP address — so whether Adyen accepts such a payment with an email alone is still to be
confirmed in a sandbox.

When Adyen answers with an action, `completePayment` reports `requires_action` with Adyen's
answer on `PaymentInfo.raw` (`raw.action`). Adyen can answer an action without a
`pspReference` (its native 3-D Secure 2 example does), and `pspPaymentId` is then the empty
string. That is not a reference: `capturePayment`, `cancelPayment` and `refundPayment` refuse
an empty `pspPaymentId` with `invalid_request`, so don't store it over one, and correlate the
attempt by `PaymentInfo.id`, the merchant reference. When the `/payments` answer does carry a
`pspReference` (Adyen's redirect example does), `pspPaymentId` is the usual composite. Hand
the action to `handleAction`: Adyen Web replaces the card fields with the fingerprint or
challenge in the same element and resolves with a second `clientToken`, the
`onAdditionalDetails` data `{ details: { threeDSResult } }`, which you complete exactly like
the first; the server sends it to `/payments/details`. That answer can carry another action,
so loop until it doesn't:

```tsx
import { PayFanoutError } from "@payfanout/core";
import { createEndpointCompletion, usePayFanoutContext, type PayResult } from "@payfanout/react";

// Pass what <PayButton onResult> reports through finish() before showing the outcome.
function useAdyenActions() {
  const { mountedRef } = usePayFanoutContext();
  return async function finish(result: PayResult): Promise<PayResult> {
    let current = result;
    while (current.status === "requires_action") {
      const mounted = mountedRef.current;
      const action = (current.info?.raw as { action?: Record<string, unknown> } | undefined)?.action;
      if (!mounted || !action) return current;
      // Inline for a threeDS2 action; a redirect action navigates to Adyen instead.
      const next = await adyen.handleAction(mounted.handle, action);
      if (next.status !== "requires_confirmation" || !next.clientToken) {
        return { status: next.status, error: next.error };
      }
      try {
        const info = await createEndpointCompletion("/api/complete", mounted.sessionRef)(next.clientToken);
        current = { status: info.status, info };
      } catch (error) {
        // A PayFanoutError passes through unchanged; anything else, such as a failed fetch, is wrapped.
        return { status: "failed", error: PayFanoutError.wrap(error) };
      }
    }
    return current;
  };
}
```

`PayFanoutError` comes from `@payfanout/core`, which `@payfanout/react` depends on; add it to
your own dependencies to import it. `handleAction` is Adyen-specific: the unified contract has
no action step, because most PSPs resolve challenges inside `confirm()`. One completion
handler with one `idempotencyKey` is fine across a multi-step challenge: the adapter derives
the key it sends from your key, the merchant account, the endpoint and, on
`/payments/details`, the details themselves.

Every answer is checked against the session it completes. A `/payments` answer naming another
`merchantReference` or `amount` is refused with `invalid_request`, not retryable: the answer
belongs to another request, since an `idempotencyKey` reused across sessions replays the first
answer. A `/payments/details` answer finishes whichever payment the details were issued for,
so one whose `merchantReference` or `amount` differs from the signed session is refused the
same way. An answer that does not name the session's merchant reference and amount (Adyen's
own example answer names neither) reads `processing` and carries no `pspPaymentId`; the
`AUTHORISATION` webhook (§8), whose `merchantReference` is one of the signed values, supplies
the reference: `encodeAdyenPaymentRef(event.pspPaymentId, event.amount, event.currency)`.

One challenge runs at a time per mounted field set: calling `handleAction` again while one is
outstanding fails with `invalid_request` rather than abandoning the first caller's promise.
Adyen Web's 3-D Secure 2 elements report timeouts through `onAdditionalDetails` and call
`onError` only when they stop, so an error reported through `onError` meanwhile settles the
pending promise as `failed` with `authentication_required` (or a retryable `psp_unavailable`
when it reads as a load or network failure), and unmounting the fields settles it as `failed`
too. Once `handleAction` has run, the card fields are gone: `confirm()` on that handle fails
with `invalid_request`, so remount `<PaymentFields>` for another attempt, with a fresh
`idempotencyKey` (§7).

### Redirect fallback

`nativeThreeDS: "preferred"` states a preference: Adyen can still choose its redirect flow.
When the `clientToken` carries no usable `browserInfo` or `origin`, the adapter omits
`nativeThreeDS` (with `channel` and `origin`) and expects the redirect flow. That is an
inference Adyen does not document — its redirect guide lists `channel` and `origin` as
required too — and a sandbox run is still to confirm it. The action is then
`type: "redirect"`, and `handleAction` navigates the page to Adyen; its promise never
settles. After authenticating, the shopper returns to the session's `returnUrl` with a
URL-encoded `redirectResult` appended to your own query parameters
([redirect 3-D Secure guide](https://docs.adyen.com/online-payments/3d-secure/redirect-3ds2/web-component)).
Carry your order reference in that `returnUrl`; the return page turns the result into a
`clientToken` with `adyenRedirectResultToken` and completes the payment as usual:

```ts
import { adyenRedirectResultToken } from "@payfanout/adapter-adyen";
import { createEndpointCompletion } from "@payfanout/react";

// https://your-shop.example/checkout/return?order=1234&redirectResult=…
const params = new URLSearchParams(window.location.search);
const redirectResult = params.get("redirectResult"); // already URL-decoded
if (redirectResult) {
  const sessionRef = await clientSecretForOrder(params.get("order")); // your storage: the clientSecret the fields were mounted with
  const info = await createEndpointCompletion("/api/complete", sessionRef)(adyenRedirectResultToken(redirectResult));
  showOutcome(info);
}
```

The card method is embedded, so `<RedirectReturn>` does not pick this page up. The completion
still runs against the signed session, within `sessionTtlSeconds` of `createPaymentSession`
(one hour by default); after that it is refused with `session_expired`. Adyen goes on to
authorise the payment once the shopper has authenticated, whether or not they return, so the
`AUTHORISATION` webhook is where its outcome arrives either way.

## 7. The server-completion route

When the client encrypts the card, the library POSTs the resulting `clientToken` (with the
session reference) to your `completionEndpoint`, where you mount `createCompletionHandler`;
the 3-D Secure tokens of §6 go to the same route. Store a random (v4) UUID on each completion
attempt of an order and pass it as that attempt's `idempotencyKey`. The same key serves every
step of the attempt, because the adapter derives a distinct Adyen key per request from it:

```ts
import { createCompletionHandler } from "@payfanout/server";

// POST /api/complete
const complete = createCompletionHandler({
  resolveSession: async (sessionRef) => {
    // One record per attempt: another card on the same order gets a new session and key.
    const attempt = await db.paymentAttemptByClientSecret(sessionRef); // your storage
    // attempt.idempotencyKey: crypto.randomUUID(), stored when the attempt was created.
    return { service: payments, pspName: "adyen", pspSessionId: attempt.pspSessionId, idempotencyKey: attempt.idempotencyKey };
  },
});
```

Under the hood it calls `completePayment`, which verifies the session signature and expiry,
then creates the payment, or finishes it through `/payments/details` for a 3-D Secure token.
Adyen answers a key it has seen with its first answer for
[7 to 14 days](https://docs.adyen.com/development-resources/api-idempotency), so a key
reused after a refusal replays the refusal instead of charging the shopper's next card:
start a new attempt, with a new session and key, when the shopper tries again. Within an
attempt the key stays the same, so a retried POST is deduplicated at Adyen. Prefer to
hand-write the route? Call `completePayment` directly, both forms are in
[Server usage](/guide/server#server-completion-tokenize-first).

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

In **Developers → Webhooks**, add a *Standard webhook* pointing at
`https://your-api.example/webhooks/adyen`, generate its **HMAC key**, and set **basic
authentication** credentials. The adapter requires both:

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
  onEvent: (event) => enqueue(event), // ack-fast: enqueue, dedupe by event.id; never process inline
});

app.post("/webhooks/adyen", express.raw({ type: "application/json" }), async (req, res) => {
  const r = await adyenHook({ rawBody: req.body.toString("utf8"), headers: req.headers });
  res.status(r.status).end();
});
app.use(express.json()); // AFTER the webhook route
```

A JSON delivery
[carries exactly one notification item](https://docs.adyen.com/development-resources/webhooks/webhook-types)
(SOAP may carry up to six; the adapter speaks JSON). `success` and `live` are the
**strings** `"true"`/`"false"`, never booleans — the adapter compares the exact string, and so
should any code you write against `event.raw`. The dedupe key is the pair
`"{eventCode}:{pspReference}"`, because one payment's `AUTHORISATION` and `CAPTURE` share a
reference but are different events.

Adyen's signature covers **eight extracted values, not the delivered bytes**, so a body a
middleware deserialized and re-serialized still verifies — by design, and the adapter
declares it as `webhookSignatureScope: "field-values"`. Refusing such a body would mean
guessing Adyen's wire format, and a wrong guess rejects every legitimate delivery. Two
consequences land on your handler:

- **Basic authentication is what authenticates the caller.** A signature over values proves
  the values came from Adyen, never who posted them — hence the credential requirement above.
- **Everything outside those eight fields arrives unauthenticated**, including everything you
  read from `event.raw`. Treat `additionalData`, `reason`, `paymentMethod` and `eventDate` as
  untrusted input; a delivery whose signed values contain the `:` delimiter is refused
  outright, since Adyen documents no escaping rule and the signed payload would be ambiguous.

Keep the raw body all the way to the handler anyway: it costs nothing, and it is what every
other PSP's verification hashes.

Adyen exposes no events-polling API (`supportsEventPolling: false`), and there is no
`retrievePayment` to reconcile against, so treat the webhook queue as the system of record:
persist every event, dedupe by `event.id`, and alert on gaps.

## 9. Test values

Use
[Adyen's documented sandbox cards](https://docs.adyen.com/development-resources/test-cards-and-credentials/test-card-numbers)
— Visa `4111 1111 1111 1111` and Mastercard `5555 5555 5555 4444`, both expiry `03/2030`,
CVC `737`. **Refusals are triggered by field values, not by the card number**: put the
trigger in `paymentMethod.holderName` or `additionalData.RequestedTestAcquirerResponseCode`,
per
[Adyen's testing page](https://docs.adyen.com/development-resources/testing/result-codes).
Confirm the current list before relying on it.

## 10. Go live

- [ ] Swap in the **live** API key, merchant account, HMAC key and webhook credentials.
- [ ] Set `environment: "live"` on **both** adapters and add `liveUrlPrefix` on the server one
      — Adyen issues the prefix per company account, under Developers → API URLs in the live
      Customer Area ([live endpoints](https://docs.adyen.com/development-resources/live-endpoints)).
- [ ] Allowlist your production origin for the **live** client key in the Customer Area.
- [ ] Register the **live** webhook, with HMAC **and** basic authentication, and verify a test
      delivery reaches your queue.
- [ ] Keep `ADYEN_SESSION_KEY` stable and secret in production; rotating it invalidates
      in-flight sessions.
- [ ] Verify card fields are still Adyen's hosted iframes (SAQ-A), no raw card input.
- [ ] Re-check endpoint paths, [event codes](https://docs.adyen.com/development-resources/webhooks/webhook-types),
      [result codes](https://docs.adyen.com/online-payments/build-your-integration/payment-result-codes)
      and [refusal reason codes](https://docs.adyen.com/development-resources/refusal-reasons)
      against the current Adyen documentation.

Then continue with [Server usage](/guide/server), [React usage](/guide/react), and
[Webhooks](/guide/webhooks).
