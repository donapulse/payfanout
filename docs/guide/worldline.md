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
deterministic `X-GCS-Idempotence-Key` derived from your `idempotencyKey`. A `409`,
Worldline's answer while the original request under that key is still being processed, is
retried; one that outlives the retries rejects with a retryable `processing_error` marked
`outcomeUnknown: true`, since the original may still go through: retry it under the same
key, never a new one.
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

### Paying again under the same key

Worldline answers a request sent again under an idempotency key it has seen with that key's
first outcome, even with a different payload, for at least 24 hours from the key's first
request. A stable key such as `complete-${order.id}` still lets the customer pay with another
card after a failed attempt: when the key answers with a replayed failure, `completePayment`
sends the payment again under a key derived from yours and the failed attempt, and goes on
from there. Every completion walks the same keys in the same order and stops at the first
attempt that did not fail, so a completion repeated after a success returns that payment and
charges nothing.

An attempt counts as failed only once its payment was declined or cancelled. When the
replayed answer does not already say so, `completePayment` reads the payment back first:

- **A 3-D Secure challenge** that failed or was cancelled is walked past. One still open comes
  back as `requires_action` with its redirect URL, because the customer may still finish it,
  and any other, one that went through or one handed on to a pending authorisation, is
  returned as it now reads.
- **A payment still pending when it was created**, such as Worldline's statuses 50 (fraud
  screening), 51 (awaiting the acquirer) and 52 ("Authorisation not known"), is walked past
  once it failed. Until then it is returned as it now reads, `processing` included; of 52,
  Worldline says the request "might have been successful" and asks not to resend it.
- **A payment authorised or captured when it was created**, a manual-capture authorisation
  included, is always returned as it now reads, and never walked past, even once cancelled.
- **A decline whose error body reports a payment that has not ended** rejects with its usual
  `code` marked `outcomeUnknown: true`, because that payment may still go through. No Worldline
  page shows such an answer, and the API contract does not rule it out. Complete again only
  under the same key: once the payment failed, the next completion walks past it, and once it
  went through, the next completion returns it.

The walk has limits:

- **An abandoned challenge holds the key.** Worldline keeps a challenge the customer abandoned
  open "indefinitely", so the key keeps returning it rather than send a second payment that
  could be charged alongside it. Before the customer pays under a new idempotency key, cancel
  that payment with `cancelPayment` while Worldline reports it cancellable
  (`raw.statusOutput.isCancellable` on `retrievePayment`); one you cannot cancel may still go
  through, so reconcile it before charging again.
- **A key carries at most 20 attempts.** The next completion rejects with a non-retryable
  `invalid_request` whose `raw.reason` is `"attempt_limit"`. Every attempt under the key was
  read back and failed, so it carries no `outcomeUnknown`: create a new session and complete
  it under a new idempotency key.
- **The first attempt must outlive the session.** Every completion starts from your key's own
  first attempt, which Worldline promises to keep for at least 24 hours. When that attempt
  failed and the session could still be completed after Worldline may have forgotten it (a
  session under the same key that expires 23 hours or more after that attempt, so one
  created about 22 hours after it with the default one-hour `sessionTtlSeconds`), the
  completion rejects with a non-retryable `invalid_request` whose `raw.reason` is
  `"first_attempt_may_expire"`, instead of sending anything, since a forgotten first attempt
  would go out as a new one. A replay timestamp that is not the documented milliseconds, or
  that lies more than an hour ahead of your server's clock, is refused the same way. The
  refusal reads no further than that first attempt, and a later one under the key may hold a
  payment, so it is marked `outcomeUnknown: true`. Complete it under a new idempotency key
  (one that includes the session, for example) only after your records or webhooks show no
  payment under this key succeeded.
- **Past Worldline's idempotence period, a completion under the key is a new first attempt.**
  The period runs from the key's first attempt, not from the success: once that first attempt
  is more than 24 hours old, Worldline may have forgotten it, and a completion under the key
  can charge again however recent the success. Record every completed payment (`onCompleted`,
  webhooks) and never complete a paid order again.
- **A re-send can meet either of two replays.** After a timeout or a lost connection the
  adapter sends the same key again, and Worldline may answer with the call's own first
  request, processed but unanswered, or with an earlier completion's attempt. A replayed
  attempt made more than 15 minutes before the call's first send is an earlier completion's,
  and the walk goes on as the first send would have. Any other is taken as the call's own, and
  a failure among them rejects marked `outcomeUnknown: true`, since a later attempt under the
  key may hold a payment: complete again under the same key, which returns that payment or
  sends the new attempt. A 409, 429 or 5xx never leads to a new attempt; it keeps its
  retryable error.

### Declines

`completePayment` rejects with a `PayFanoutError` when Worldline refuses the payment, whether
Worldline answers with HTTP 402 or with a 2xx whose payment is `REJECTED`. The first error's
`errorCode` decides the `code`, read from `error.raw.errors` for a 402 and from
`error.raw.payment.statusOutput.errors` for a `REJECTED` payment (the deprecated `code` field
stands in when there is no `errorCode`), following Worldline's
[API troubleshooting guide](https://docs.direct.worldline-solutions.com/en/integration/api-developer-guide/api-troubleshooting)
and its [Sips response-code mapping](https://docs.direct.worldline-solutions.com/en/migrate/migrate-from-sips/response-codes-mapping),
whose third column gives the `errorCode`:

| Worldline `errorCode` | `code` |
| --- | --- |
| `30431001` (stolen card), `30411001` (lost card), `30071001` (fraud account), `30591001` (used for fraud) | `fraud_suspected` |
| `30001100`, `30001101`, `30001102`, `30001104`, `30001105`, `30001106`, `30001120`, `30001130`, `30001140`, `30001141`, `30001142`, `30001143`, `30001158`, `30001180` (rejected by your Fraud Prevention module) | `fraud_suspected` |
| `30141001` (invalid card number), `30151001` (no such issuer) | `invalid_card_data` |
| `30331001`, `30541001` (expired) | `expired_card` |
| `30511001` | `insufficient_funds` |
| `40001134` (failed 3-D Secure check), `40001139` (the issuer insists on 3-D Secure) | `authentication_required` |
| `40001135`, `50001081`, `40001137`, `40001138`, `40001146` (3-D Secure failed outside the customer's control), `30911001` (issuer unreachable), `30681001` (no response, or too late), `30991001` and `30201001` (an incident on the acquiring side) | `processing_error` |
| `30031001` (the acquirer refused your merchant id), `30301001` (format error), `50001087` (3-D Secure failed on a technical issue with the request) | `invalid_request` |
| Any other code, or none | `card_declined` |

On a `REJECTED` payment, an error with no code from this table is read by its own
`httpStatusCode`: a 4xx other than 402 means Worldline refused the request rather than the
card, and comes back as `invalid_request`; a 5xx is a failure on Worldline's side rather than
the card's, and comes back as `processing_error`.

None of them is `retryable`: each is that attempt's answer, and a completion repeated under
the same idempotency key goes out as a new attempt with the card it carries (see
[Paying again under the same key](#paying-again-under-the-same-key)), which is the customer's
step to take, never an automatic retry. A decline marked `outcomeUnknown: true` needs more
care: its attempt, or a later one under the key, may hold a payment, so complete again only
under the same key, never a new one. The `message` is PayFanout's text for the `code`,
never Worldline's own, which Worldline marks as not meant for customers; Worldline's whole
answer stays on `error.raw`. An HTTP 429 or 5xx answer is never read as a decline: it stays
`rate_limited` or `psp_unavailable`, retryable, whatever code it carries.

A payment refused after a 3-D Secure redirect, on a failed challenge (`40001134`) for
instance, does not reject with one of these codes, since `completePayment` has already
returned `requires_action` (§6). `retrievePayment` reports it as `status: "failed"`, with
Worldline's errors on `PaymentInfo.raw.statusOutput.errors`, its `payment.rejected` webhook
parses as `payment.failed`, and the next completion under the key walks past it.

## 8. Register the webhook endpoint

In the Merchant Portal, under **Developer → Webhooks**, add
`https://your-api.example/webhooks/worldline` with **Add webhook endpoint**. If the page shows
"No keys generated", click **Generate webhooks keys** and copy the **Webhooks ID** and the
**Secret Webhook Key** into `WORLDLINE_WEBHOOKS_KEY_ID` / `WORLDLINE_WEBHOOKS_SECRET_KEY` right
away: the portal shows the secret for 60 seconds only. If your account already has a pair
(the Back Office manages the same pair, and changes sync between the two), do **not** click
**Generate webhooks keys** during setup: it creates a new pair and revokes the existing one
immediately, which breaks whatever verifies deliveries with it today. Reuse that pair if you
hold its secret, or replace it as described under **Rotating the webhook key** below. Mount
the handler with the **raw body** (signature verification hashes the exact bytes):

```ts
import { createAdapterWebhookHandler } from "@payfanout/server";
const worldlineHook = createAdapterWebhookHandler(worldline, {
  onEvent: (event) => enqueue(event), // ack-fast: enqueue; run the refund re-read before deduping by event.id (below)
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
rather than partially processed.

**Event ids follow Worldline's definition of a duplicate.** Worldline delivers some events
more than once by design, and its webhooks guide states: "Duplicate webhooks will have
identical values for both properties payment.id and type." Those are the only fields it
documents as identical. Any other one, the envelope `id` included, may differ on a
redelivery, and putting it in the key could let a duplicate through. So `event.id` is built
from that pair alone, `worldline:<type>:<payment id>` (the refund's id when the event carries
a refund and no payment), just as the Adyen adapter keys on the pair Adyen documents. An
event without the pair falls back to the envelope `id`, then to a hash of the raw body, and
so do payment-link events (their resource has no `id`) and `payment.test` messages (each one
carries the same documented `payment.id`, `9999_9`). Keep deduping on `event.id` as for any
other PSP.

**Two events can share an id, so re-read refunds on every refund delivery.** The same guide
hedges the premise that keeps distinct operations apart: "The payment.id can change after
each maintenance operation following an incremental logic. However, as this is not the case
in some specific scenarios, we strongly recommend not building your business operations
around it." Its Status Changes table gives a capture and a refund an id of their own, but the
prose of both confirmation rows describes updating an earlier one ("updates the original
capture request payment.id1 … payment.captured", "… payment.id2 … payment.refunded"). So two
events of the same type on the same `payment.id` share an `event.id`: when two partial
refunds are confirmed under one `payment.id`, your store keeps the first delivery and drops
the second as a duplicate. A fallback that runs only for the deliveries your store keeps
would miss it:

- On **every** verified refund-type delivery, whether or not its `event.id` was already
  seen, re-read the order it belongs to: `retrievePayment` for `amountRefunded`, and
  `retrieveRefund` for each of its refunds you created that is still `pending`. Refund-type
  means `payment.refunded`, `payment.refund_failed`, and `unknown` events whose
  `event.raw.type`, lower-cased, starts with `refund.` (such as `refund.refund_requested`).
  Both reads are idempotent, so a duplicate costs a request, never a double booking. Match
  the event to its order as described below; the scheduled reads cover any you cannot match.
- Poll `retrieveRefund` on a schedule until every refund you created has left `pending`.
- Reconcile captured payments with `retrievePayment` on a schedule as well. It catches
  refunds and other operations made outside PayFanout, in the Merchant Portal for example,
  whose events you may have no way to match, and Worldline itself recommends a back-up
  mechanism, such as a GetPaymentDetails request, for any webhook your system does not
  process correctly.
- Never sum `event.amount` across Worldline refund events: a merged or missed event leaves
  the total short. Take `amountRefunded` from `retrievePayment` instead.

**Correlate events with your order.** A maintenance operation usually changes the
`payment.id` at Worldline, so the events that follow one can carry the operation's id as
`event.pspPaymentId` instead of the one `completePayment` returned:
`payment.capture_requested` and `payment.captured` after `capturePayment`,
`refund.refund_requested` and `payment.refunded` after `refundPayment`, and possibly
`payment.cancelled` after `cancelPayment`, since a cancellation is a maintenance operation
too. A lookup by `event.pspPaymentId` alone can miss your order, and each route below covers
only part of it:

- **The session `id`, echoed as `merchantReference` (shown on sale events only).** Pass your
  order id as `id` to `createPaymentSession`; the adapter sends it as
  `order.references.merchantReference`, and sends nothing without one. Worldline's examples
  show it at `event.raw.payment.paymentOutput.references.merchantReference` on the events of
  a sale (`payment.created`, `payment.authorization_requested`, `payment.captured`). No
  documented example is a maintenance event, so the echo on capture, cancellation, and refund
  events is unverified: check it in your sandbox before you rely on it.
- **The refund id (refunds made through `refundPayment` only).** `refundPayment` returns the
  composite `refundId` `{paymentId}:{refundId}`, and the part after the last `:` is the
  refund's own id. In the `payment.id` column of the Status Changes table, that is the id
  `payment.refunded` carries (`event.pspPaymentId`) and the one `refund.refund_requested`
  carries (`event.refundId`); the prose quoted above names the capture's id for
  `payment.refunded` instead, so confirm it in your sandbox too. A refund made in the
  Merchant Portal leaves you no composite to match.
- **A re-read by the original `pspPaymentId` (every payment `completePayment` created).**
  `retrievePayment` with the `pspPaymentId` that `completePayment` returned; `capturePayment`,
  `cancelPayment`, and `refundPayment` keep taking that id too. It reports the payment's
  state, not which event arrived.

`capturePayment` and `cancelPayment` do not return the operation's own id, so capture and
cancellation events, like operations made in the Merchant Portal, can only be matched through
the `merchantReference` echo, or settled by a scheduled `retrievePayment` of the orders still
awaiting confirmation. Worldline documents GetPaymentDetails as the way to trace these ids:
its `operations[].id` lists the ids a payment took over its life cycle. The adapter does not
wrap it. Splitting the composite `refundId` at its last `:` is the only parsing to do: treat
every other Worldline id, and the tail of `event.id`, as opaque.

**Answer fast; Worldline retries failures.** The handler answers as soon as `onEvent`
returns, which is why `onEvent` should only enqueue. A delivery that gets no 2xx is retried
five times, 10 minutes, 1 hour, 2 hours, 8 hours, and 24 hours after the previous attempt,
so the last retry comes 35 hours 10 minutes after the first attempt, and every attempt
carries a `retry-count` header: `0` on the first, rising with each retry.

**Rotating the webhook key.** In the portal, **Generate webhooks keys** creates a new pair and
revokes the current one immediately, so deliveries fail verification until your server knows
the new pair. Choosing the new pair yourself shrinks that gap to the moment between clicking
**Generate webhooks keys** and **Confirm** (Worldline does not say when the revocation
happens), and a delivery rejected in that moment is retried, the first retry 10 minutes later.
Draw the pair from a secure random generator: a random key id (for example
`openssl rand -hex 16`) and a secret of at least 32 random bytes (for example
`openssl rand -base64 32`). Worldline documents no format rules for a pair you enter yourself;
if the portal refuses a character, `openssl rand -hex 32` gives 32 random bytes as hex digits
only. Then:

1. Add the new pair to `webhookKeys` next to the current one, and deploy.
2. In **Developer → Webhooks**, click **Generate webhooks keys**, enter the pair as your own
   **Webhook ID** and **Webhook Secret Key**, and click **Confirm** without delay. The new
   pair has to be deployed first because the current one may already be revoked at the click.
3. Remove the old pair once nothing it signed can still arrive: Worldline does not say
   whether a retry is re-signed with the current key, and retries run for 35 hours
   10 minutes, so keep it for at least 36 hours (remove it at once if the secret leaked).

If you let the portal generate the pair instead, add it to `webhookKeys` and deploy straight
away; deliveries rejected in between are retried, the first after 10 minutes.

To check the setup before real traffic arrives, Worldline's API offers
`ValidateWebhookCredentials` and `SendTestWebhook`; the adapter wraps neither.
`ValidateWebhookCredentials` takes your key id and, in its `secret` field, not the secret
itself but the signature your server would compute over an empty body,
`base64(HMAC-SHA256(webhookSecret, ""))`; it answers `Valid` or `Invalid` for the pair on your
account. `SendTestWebhook` delivers a test message to your endpoint: a `payment.test` event,
mapped to `unknown` and keyed on its envelope `id` as described above.

Worldline exposes no public events-polling API (`supportsEventPolling: false`), for
missed-webhook recovery, reconcile with `retrievePayment` per order. See
[Webhooks](/guide/webhooks).

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
