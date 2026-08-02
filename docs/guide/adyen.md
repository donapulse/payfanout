# Set up Adyen

Adyen is a **tokenize-first** PSP: the browser encrypts the card inside Adyen's hosted
fields, then your **server** creates the payment from that encrypted blob. It is also the
first **push-only** provider PayFanout ships: Adyen's Checkout API exposes no read for a
payment or a refund, and every capture/cancel/refund answers `{ "status": "received" }` —
the real outcome arrives as a webhook. The adapter declares that honestly
(`supportsPaymentRetrieval: false`, `supportsRefundRetrieval: false`,
`modificationOutcome: "asynchronous"`) instead of inventing states, so **your webhook
endpoint is not optional here** — it is the only place outcomes exist.

Two packages: [`@payfanout/adapter-adyen-server`](/guide/server) (holds your API key;
**edge-runtime compatible**, WebCrypto only, runs on Cloudflare Workers / Next.js edge) and
[`@payfanout/adapter-adyen`](/guide/react) (browser-safe, holds only the public client key).

::: warning Adyen API details evolve
Endpoint hosts, Customer Area menu names, webhook event lists, and test values change over
time and vary per account. The **field names and behavior below are exact** (read from the
adapter source), but re-verify credential locations, test cards, and refusal triggers against
your own [Adyen documentation](https://docs.adyen.com) before going live.
:::

## 1. Get your Adyen credentials

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
`idempotencyKey` **and the endpoint being called** (Adyen caps the header at 64 characters,
so it travels as a SHA-256 digest). The endpoint is part of it because Adyen stores keys at
company-account level, not per endpoint: reusing one key across `/payments` and
`/payments/details` — which the 3-D Secure flow in §6 does — would otherwise replay the
first answer instead of finishing the payment. Replaying the *same* call with the same key
still deduplicates at Adyen. A duplicate racing the still in-flight original (Adyen
`errorCode` 704) is retried automatically; a refusal never is.
:::

### Currencies the adapter refuses

Adyen prices **CLP, CVE, IDR and ISK** with a different number of fractional digits than
ISO 4217, which is PayFanout's minor-unit contract. Passing minor units straight through
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

In **Developers → Webhooks**, add a *Standard webhook* pointing at
`https://your-api.example/webhooks/adyen`, generate its **HMAC key**, and set **basic
authentication** credentials. The adapter requires both:

- the HMAC key authenticates the eight signed fields (`pspReference`, `originalReference`,
  `merchantAccountCode`, `merchantReference`, amount `value` and `currency`, `eventCode`,
  `success`);
- basic authentication authenticates the channel the *rest* of the payload arrived on —
  Adyen's HMAC does not cover it, and hosts read those fields from `event.raw`.

::: warning Basic authentication, not OAuth
Adyen strongly recommends **OAuth 2.0** for standard webhooks and offers basic
authentication over HTTPS as the alternative. This adapter verifies the basic-auth
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

A JSON delivery carries exactly one notification item. `success` and `live` are the
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

Use Adyen's documented sandbox cards — Visa `4111 1111 1111 1111` and Mastercard
`5555 5555 5555 4444`, both expiry `03/2030`, CVC `737`. **No card number triggers a
refusal**: refusals are simulated with `paymentMethod.holderName` values or
`additionalData.RequestedTestAcquirerResponseCode` from Adyen's testing page. Confirm the
current list before relying on it.

## 10. Go live

- [ ] Swap in the **live** API key, merchant account, HMAC key and webhook credentials.
- [ ] Set `environment: "live"` on **both** adapters and add `liveUrlPrefix` on the server one.
- [ ] Allowlist your production origin for the **live** client key in the Customer Area.
- [ ] Register the **live** webhook, with HMAC **and** basic authentication, and verify a test
      delivery reaches your queue.
- [ ] Keep `ADYEN_SESSION_KEY` stable and secret in production; rotating it invalidates
      in-flight sessions.
- [ ] Verify card fields are still Adyen's hosted iframes (SAQ-A), no raw card input.
- [ ] Re-check endpoint paths, event codes, and refusal reason codes against the current
      Adyen documentation.

Then continue with [Server usage](/guide/server), [React usage](/guide/react), and
[Webhooks](/guide/webhooks).
