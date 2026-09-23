# Set up Worldline

Worldline Direct is a **tokenize-first** PSP: the browser tokenizes the card inside the
Hosted Tokenization Page iframe into a `hostedTokenizationId`, then your **server** creates
the payment from that id. This inverts Stripe's flow, and PayFanout models both as
first-class, the React code is identical, but Worldline needs one extra thing Stripe
doesn't: a **server-completion route** (step 7).

Two packages: [`@payfanout/adapter-worldline-server`](/guide/server) (holds your API key and
secret; **edge-runtime compatible**, WebCrypto only, runs on Cloudflare Workers / Next.js
edge) and [`@payfanout/adapter-worldline`](/guide/react) (browser-safe, holds **no** key at
all — the iframe is addressed by the session's `hostedTokenizationUrl`).

::: warning Worldline API details evolve
Endpoint hosts, portal menu names, webhook event lists, and test-card lists change over time
and vary per contract. The **field names and behavior below are exact** (read from the
adapter source), but re-verify credential locations, test cards, and decline triggers against
your own [Worldline Direct documentation](https://docs.direct.worldline-solutions.com) before
going live.
:::

## 1. Get your Worldline credentials

Both key pairs come from the **Worldline Merchant Portal** (see Worldline's
[authentication](https://docs.direct.worldline-solutions.com/en/integration/api-developer-guide/authentication)
and [webhooks](https://docs.direct.worldline-solutions.com/en/integration/api-developer-guide/webhooks)
guides; Back Office and e-Portal users follow the chapters those pages link for their tool):

- **API key id + secret API key:** Developer → Payment API → *Add API Key*. The screen then
  shows the pair under *API Key ID* / *Secret API Key*.
- **Webhook key id + secret:** Developer → Webhooks → *Generate webhooks keys* shows the
  *Webhooks ID* and its *Secret Webhook Key*; you can instead enter your own id and secret and
  confirm.

Each secret is displayed for **60 seconds only** and never again, so copy it into your secret
store as soon as it appears. The key ids stay visible in the portal.

API key pairs **expire**: renew before the date in the *Expiration date* column under
Developer → Payment API. Creating a new **API key** pair **revokes** the current one, which
then expires within **four hours**, so deploy the new `apiKeyId` / `secretApiKey` inside that
window. Webhook key pairs get no such window: generating a new pair revokes the current one
immediately, so add the new pair to `webhookKeys` before you switch it in the portal.

| Credential | What it is | Used by |
| --- | --- | --- |
| **API key id** | The `v1HMAC` key identifier (not a secret on its own) | server adapter (`apiKeyId`) |
| **Secret API key** | The `v1HMAC` signing secret (server-only) | server adapter (`secretApiKey`) |
| **Merchant id (PSPID)** | The `{merchantId}` path segment on every endpoint | server adapter (`merchantId`) |
| **Webhook key id + secret** | Sign/verify webhook payloads; `keyId` matches `X-GCS-KeyId` | server adapter (`webhookKeys`) |

Sandbox and live are **separate credential sets** and **separate hosts**, the adapter derives
the host from `environment` (`sandbox → payment.preprod.direct.worldline-solutions.com`,
`live → payment.direct.worldline-solutions.com`).

::: danger One secret you generate yourself
`sessionSigningKey` is **not issued by Worldline.** Because PayFanout is stateless, the
Worldline "session" is a **signed, self-contained token**, amount, currency, capture method,
and the `hostedTokenizationId` are HMAC-signed into it so the browser can round-trip it but
cannot tamper with the amount. That HMAC key is **yours**. Generate a strong random secret
once and keep it stable:

```bash
openssl rand -hex 32   # → WORLDLINE_SESSION_KEY
```

If it changes (or differs between server instances), previously issued sessions fail
signature verification at completion. The client adapter never needs this key.
:::

## 2. Install

```bash
# server
pnpm add @payfanout/server @payfanout/adapter-worldline-server
# client (React)
pnpm add @payfanout/react @payfanout/adapter-worldline react react-dom
```

The Worldline `Tokenizer` script is **not** an npm dependency; the client adapter injects it
lazily from the Worldline host on first mount.

## 3. Environment variables

```bash
# .env (server), never committed
WORLDLINE_API_KEY_ID=…
WORLDLINE_SECRET_API_KEY=…
WORLDLINE_MERCHANT_ID=…
WORLDLINE_SESSION_KEY=…             # YOUR secret, openssl rand -hex 32 (not from Worldline)
WORLDLINE_WEBHOOKS_KEY_ID=…
WORLDLINE_WEBHOOKS_SECRET_KEY=…
```

The **client bundle needs no Worldline env var** — the browser holds no key; the session's
`clientSecret` (the `hostedTokenizationUrl`) is all the iframe needs.

## 4. Wire the server adapter

```ts
import { PaymentService } from "@payfanout/server";
import { WorldlineServerAdapter } from "@payfanout/adapter-worldline-server";

const worldline = new WorldlineServerAdapter({
  apiKeyId: process.env.WORLDLINE_API_KEY_ID!,
  secretApiKey: process.env.WORLDLINE_SECRET_API_KEY!,
  merchantId: process.env.WORLDLINE_MERCHANT_ID!,
  environment: "sandbox",                                  // → payment.preprod.direct.worldline-solutions.com
  defaultReturnUrl: "https://your-shop.example/checkout/return", // required unless every session passes returnUrl
  sessionSigningKey: process.env.WORLDLINE_SESSION_KEY!,   // YOUR HMAC secret, not a Worldline credential
  webhookKeys: [
    { keyId: process.env.WORLDLINE_WEBHOOKS_KEY_ID!, secretKey: process.env.WORLDLINE_WEBHOOKS_SECRET_KEY! },
  ],                                                       // pass several to rotate with no cutover
});

const payments = new PaymentService({ adapters: [worldline] });
```

| Field | Required | Default | Notes |
| --- | --- | --- | --- |
| `apiKeyId` / `secretApiKey` | ✅ | - | `v1HMAC` request-signing credentials. Server-only. |
| `merchantId` | ✅ | - | The merchant id (PSPID); the `{merchantId}` path segment. |
| `environment` | ✅ | - | Exactly `"sandbox"` or `"live"`; selects the API host. Never inferred. |
| `defaultReturnUrl` | ✅¹ | - | Where Worldline returns the customer after a 3-D Secure challenge; the same URL rules as a session's `returnUrl` apply (§6), checked when the adapter is constructed. ¹Required unless every session passes its own `returnUrl`: Worldline lists the return URL among the mandatory 3-D Secure properties of every card payment, so a session with neither is refused (§6). **Set it before upgrading** from a release that did not require a return URL: sessions that release created without their own `returnUrl` carry none, and completing them is otherwise refused. |
| `sessionSigningKey` | ✅ | - | HMAC key for the stateless signed session. **You generate this.** Keep it stable across restarts/instances. |
| `webhookKeys` | ✅ | - | Array of `{ keyId, secretKey }`. Pass several to rotate with no cutover. |
| `sessionTtlSeconds` | - | `3600` | How long a signed session stays completable (1h). Enforced at completion. |
| `requestTimeoutMs` | - | `30000` | Abort a hung Worldline connection; surfaces as a retryable `psp_unavailable`. |
| `maxNetworkRetries` | - | `2` | Retries transport trouble (network/timeout/5xx/429) only, never business errors like declines. |

::: tip Requests are `v1HMAC`-signed and time-boxed
Each request is signed with the `v1HMAC` scheme over a canonical string (method, content-type,
`Date`, signed `X-GCS-*` headers, path) using WebCrypto. Worldline rejects timestamps older
than five minutes, so keep the server clock accurate. Every mutating call carries a
deterministic `X-GCS-Idempotence-Key` derived from your `idempotencyKey`.
:::

::: tip Capture and cancellation outcomes
When the acquirer refuses a capture or a cancellation, the payment stays authorised: it reads
`requires_capture`, with the authorisation still in `amountCapturable`, so you can capture
again or cancel. `capturePayment` returns that refusal only when Worldline answers it
straight away. Worldline documents a capture as `CAPTURE_REQUESTED` (status code 91) first,
so `capturePayment` usually resolves `processing` and the refusal (93) surfaces minutes later,
through `retrievePayment` or the `payment.rejected_capture` webhook, which parses as
`unknown`.

`cancelPayment` resolves `processing` while the acquirer has not confirmed the cancellation
(status codes 61/62); the `payment.cancelled` webhook, documented for status code 6, or a
later `retrievePayment` settles it: `canceled`, or `requires_capture` if the acquirer refuses.
Cancelling a payment that is already captured is refused with a non-retryable
`invalid_request`.

A refund the acquirer refuses leaves the payment `succeeded`: `retrieveRefund` reports the
refund `failed` and it stays out of `amountRefunded`, and a payment with a refund still in
flight also stays `succeeded`. The refused refund's `payment.rejected` webhook, carrying status
code 73 or 83, arrives as `payment.refund_failed` (read from Worldline's Statuses reference,
not yet sandbox-verified); it carries no amount unless the event holds a refund resource, so
reconcile it with `retrieveRefund`.

An automatic-capture payment can also end at `requires_capture` when Worldline refuses its
capture. [`usePaymentStatus`](/guide/react#async-rails-polling-to-a-terminal-state) does not
treat `requires_capture` as final and keeps polling it, so stop the hook yourself
(`enabled: false`) once that status arrives, then capture again or cancel from your server.

Worldline documents the capture amount "in cents", assuming two decimals, so until that unit
is confirmed for other currencies a **partial** capture in a currency without two decimals
(JPY, BHD, …) is refused with `invalid_request` and no capture request is sent. Capture the
full authorised amount instead, or cancel.
:::

## 5. Wire the client adapter

```tsx
import { PayFanoutProvider, PaymentFields, PayButton } from "@payfanout/react";
import { WorldlineClientAdapter } from "@payfanout/adapter-worldline";

const worldline = new WorldlineClientAdapter({ environment: "sandbox" });

<PayFanoutProvider adapters={[worldline]} initialPsp="worldline" completionEndpoint="/api/complete">
  {/* The Tokenizer reports form validity: onChange fires { complete: false } on mount, then
      { complete: true | false } each time that validity changes. */}
  <PaymentFields clientSecret={session.clientSecret} onChange={({ complete }) => setPayEnabled(complete)} />
  {/* completionEndpoint finishes the tokenize-first flow automatically — no onServerCompletion. See §7. */}
  <PayButton onResult={(result) => showOutcome(result)}>Pay</PayButton>
</PayFanoutProvider>
```

- The client adapter takes **only** `environment` — it holds no key. The session's
  `clientSecret` is the `hostedTokenizationUrl` the iframe mounts from.
- The adapter drives `onChange` from the Tokenizer's `validationCallback`, which Worldline
  calls whenever the form's validity changes. Validity only means the form is correctly
  filled in: the authorization outcome still surfaces **server-side** at completion (step 7).
- `fieldOptions` passes through to the `Tokenizer` constructor untouched (for example
  `paymentProductUpdatedCallback`), except `validationCallback`, which the adapter owns; a
  callback you pass there still runs, after `onChange`, with the same result.
- The cardholder-name field is **shown by default** (`hideCardholderName: false`), because
  Worldline requires the cardholder name and hides that field unless told otherwise.
  `hideCardholderName: true` in `fieldOptions` still wins, but then the name has to reach
  Worldline through its `useCardholderName` call, which the adapter neither makes nor
  exposes, so keep the field visible.

::: tip Content-Security-Policy
A CSP-enforcing page must allow the Worldline payment host, or the iframe fails quietly:

```
script-src  https://payment.preprod.direct.worldline-solutions.com https://payment.direct.worldline-solutions.com
frame-src   https://payment.preprod.direct.worldline-solutions.com https://payment.direct.worldline-solutions.com
connect-src https://payment.preprod.direct.worldline-solutions.com https://payment.direct.worldline-solutions.com
```

The `preprod` host is exercised only by `environment: "sandbox"`. Worldline requires the
Tokenizer script to load from its own servers, so never self-host it: the `sdkUrl` config
field only points the adapter at a different Worldline-served URL. Worldline also asks for
the script tag to carry `integrity` (the `sri` value of the CreateHostedTokenization response)
and `crossorigin="anonymous"`; the adapter does not apply that subresource integrity check
yet.
:::

## 6. 3-D Secure

Worldline's [3-D Secure guide](https://docs.direct.worldline-solutions.com/en/security-and-risk-management/3d-secure/implementation)
lists the properties every card payment must send, and the Hosted Tokenization guide requires
at least those on the payment request. Every payment carries the ones the adapters can
supply:

| What | Sent as |
| --- | --- |
| Cardholder name | Collected in the Hosted Tokenization iframe's name field, which Worldline hides unless the `Tokenizer` receives `hideCardholderName: false`; keep it visible, passing `fieldOptions: { hideCardholderName: false }` if your client adapter version does not default to it (see §5) |
| Return URL | `cardPaymentMethodSpecificInput.returnUrl` (the field the Hosted Tokenization guide names) **and** `cardPaymentMethodSpecificInput.threeDSecure.redirectionData.returnUrl` |
| Authentication | `threeDSecure.skipAuthentication: false`, never the deprecated flat `cardPaymentMethodSpecificInput.skipAuthentication` |
| Browser device data | `order.customer.device`: `locale`, `timezoneOffsetUtcMinutes`, `userAgent`, and `browserData` (`colorDepth`, `javaEnabled`, `javaScriptEnabled`, `screenHeight`, `screenWidth`), read in the browser by the client adapter's `confirm()` |
| Challenge preference | `threeDSecure.challengeIndicator: "challenge-required"` when the session passes `sca: { challenge: "force" }`; otherwise omitted, which is Worldline's `no-preference` default |

**The return URL is mandatory.** Pass `returnUrl` on `createPaymentSession`, or set
`defaultReturnUrl` on the adapter (§4), absolute, with a scheme such as `https://` or an app
scheme, at most 200 characters; a session with neither, or with a URL that breaks those rules,
is refused with `invalid_request` before anything reaches Worldline, rather than failing after
the customer has entered a card. An empty `returnUrl` counts as none, so `defaultReturnUrl`
applies. For Visa, Worldline also requires one customer contact detail; the adapter sends
`order.customer.contactDetails.emailAddress` from the session's `receiptEmail` or
`billingDetails.email`, so pass one of them.

Session creation refuses two more values with `invalid_request`, again before anything reaches
Worldline: an `id` longer than 40 characters, since it travels as the payment's
`order.references.merchantReference`, and a `statementDescriptor` longer than 256 characters.
The descriptor is sent as `order.references.softDescriptor`, not the deprecated `descriptor`.
Worldline advises at most 22 characters, as issuers start truncating beyond that, and
currently allows a per-payment override only for the AIB and Barclays acquirers.

`sca: { exemption: "moto" }` is not mapped yet. Worldline models MOTO as a transaction channel
(`cardPaymentMethodSpecificInput.transactionChannel: "MOTO"`), not as an exemption, so such a
payment goes out as an e-commerce payment with 3-D Secure.

`confirm()` hands the server a JSON `clientToken`,
`{"hostedTokenizationId":"…","device":{…}}`. It carries browser characteristics only, never
card data; a value the browser does not expose is left out, and the server adapter keeps only
the fields a browser can read, dropping any outside Worldline's documented types and lengths
instead of failing the payment. A bare `hostedTokenizationId` from an earlier client adapter
is still accepted, without device data, so deploy the server adapter before the client
adapter.

::: warning What the adapter does not send
Worldline also lists `order.customer.device.acceptHeader` and, for Visa and Cartes Bancaires,
`order.customer.device.ipAddress`. Both come from the customer's HTTP request to your server,
not from the browser, and neither `CompletePaymentInput` nor `createCompletionHandler` carries
them to the adapter today, so the adapter cannot send them.

Cartes Bancaires additionally requires
`cardPaymentMethodSpecificInput.paymentProduct130SpecificInput.threeDSecure.useCase`.
Worldline's API contract spells that property `usecase`, so the adapter does not send it until
a sandbox run settles the name.
:::

The adapter tokenizes with `storePermanently: false`, so no card is stored at Worldline for
later use: the adapter has no saved-card surface that could use such a token.

A frictionless authentication completes inline; a challenge comes back as `requires_action`
with the redirect URL on `PaymentInfo.raw` (`merchantAction.redirectData.redirectURL`). After
the customer returns, reconcile the outcome with `retrievePayment`.

## 7. The server-completion route (Worldline-only)

This is the step Stripe doesn't have. When the client tokenizes, the library POSTs the
resulting `clientToken` (the `hostedTokenizationId` plus the browser's 3-D Secure data, see
§6), with the session reference and any completion-time `billingDetails`, to your
`completionEndpoint`, where you mount
`createCompletionHandler`:

```ts
import { createCompletionHandler } from "@payfanout/server";

// POST /api/complete
const complete = createCompletionHandler({
  resolveSession: async (sessionRef) => {
    const order = await db.orderByClientSecret(sessionRef); // your storage
    return { service: payments, pspName: "worldline", pspSessionId: order.pspSessionId, idempotencyKey: `complete-${order.id}` };
  },
});
```

Under the hood it calls `completePayment`, which verifies the session signature and expiry,
then creates the payment (`SALE` or `PRE_AUTHORIZATION`) from the `hostedTokenizationId`. The
host id round-trips via `order.references.merchantReference` (`PaymentInfo.id`). Prefer to
hand-write the route? Call `completePayment` directly, both forms are in
[Server usage](/guide/server#server-completion-tokenize-first).

## 8. Register the webhook endpoint

Point the portal's webhook endpoint at `https://your-api.example/webhooks/worldline`, copy its
**key id** and **secret** into `WORLDLINE_WEBHOOKS_KEY_ID` / `WORLDLINE_WEBHOOKS_SECRET_KEY`,
and mount the handler with the **raw body** (signature verification hashes the exact bytes):

```ts
import { createAdapterWebhookHandler } from "@payfanout/server";
const worldlineHook = createAdapterWebhookHandler(worldline, {
  onEvent: (event) => enqueue(event), // ack-fast: enqueue, dedupe by event.id; never process inline
});

app.post("/webhooks/worldline", express.raw({ type: "application/json" }), async (req, res) => {
  const r = await worldlineHook({ rawBody: req.body.toString("utf8"), headers: req.headers });
  res.status(r.status).end();
});
app.use(express.json()); // AFTER the webhook route
```

Signatures are verified as `base64(HMAC-SHA256(webhookSecret, rawBody))` against
`X-GCS-Signature`, with the key selected by `X-GCS-KeyId`. Worldline delivers **one event per
request**; a single-event array wrapper is unwrapped, and a multi-event batch is rejected
rather than partially processed. Worldline exposes no public events-polling
API (`supportsEventPolling: false`), for missed-webhook recovery, reconcile with
`retrievePayment` per order. See [Webhooks](/guide/webhooks).

## 9. Test cards

Worldline's
[test cases](https://docs.direct.worldline-solutions.com/en/integration/how-to-integrate/test-cases/)
are for the sandbox only. These cards authorize successfully, through a frictionless or a
challenge 3-D Secure flow, with any 3- or 4-digit CVV:

| Brand | 3-D Secure frictionless | 3-D Secure challenge |
| --- | --- | --- |
| Visa | `4330 2649 3634 4675` | `4874 9706 8667 2022` |
| Mastercard | `5137 0098 0194 3438` | `5130 2574 7453 3310` |
| American Express | `3714 4963 5311 004` | `3797 6442 2997 381` |

- **Frictionless** cards authenticate without a challenge, so the outcome comes straight back
  from completion (§7).
- **Challenge** cards exercise the redirect/return trip: create the session with a `returnUrl`
  and completion returns `requires_action` with the redirect URL (§6). Once the customer is
  back on your `returnUrl`, reconcile with `retrievePayment`.
- **Decline:** any of these cards on a session with `amount: 1302` (€13.02),
  `currency: "EUR"` and the default automatic capture is declined (Worldline `statusCode` 2).
  The trigger is documented for `authorizationMode: "SALE"`, which is what the adapter sends
  for automatic capture (`captureMethod: "manual"` sends `PRE_AUTHORIZATION`).

The page also covers other brands and amount-based refund and capture outcomes; **confirm the
current list there** rather than assuming.

## 10. Go live

- [ ] Before you switch, run one **challenge-flow** test card (§9) end to end in sandbox, so
      the return to your `returnUrl` and the `retrievePayment` reconciliation are exercised.
- [ ] Swap in the **live** API key id + secret and the **live** merchant id.
- [ ] Plan the live API key renewal ahead of its *Expiration date* (Developer → Payment API):
      the old pair expires within four hours of creating a new one, so deploy the new pair
      inside that window (§1).
- [ ] Set `environment: "live"` on **both** adapters (host flips to the bare
      `payment.direct.worldline-solutions.com`).
- [ ] Register the **live** webhook endpoint in the portal and use its **live** key id + secret.
- [ ] Keep `WORLDLINE_SESSION_KEY` stable and secret in production, rotate it deliberately
      (it invalidates in-flight sessions), and store it like any other secret.
- [ ] Verify card fields are still the Worldline Hosted Tokenization iframe (SAQ-A), no raw
      card input.
- [ ] Re-check endpoint paths, webhook event types, and error codes against the current
      Worldline documentation.

Then continue with [Server usage](/guide/server), [React usage](/guide/react), and
[Webhooks](/guide/webhooks).
