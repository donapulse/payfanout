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

From the **Worldline Merchant Portal** (its API / integration settings):

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

## 5. Wire the client adapter

```tsx
import { PayFanoutProvider, PaymentFields, PayButton } from "@payfanout/react";
import { WorldlineClientAdapter } from "@payfanout/adapter-worldline";

const worldline = new WorldlineClientAdapter({ environment: "sandbox" });

<PayFanoutProvider adapters={[worldline]} initialPsp="worldline" completionEndpoint="/api/complete">
  {/* Worldline's Hosted Tokenization iframe emits no field-validity stream (onChange fires
      { complete: false } once), so do NOT gate the Pay button on `complete` for Worldline —
      the default <PayButton> doesn't, so plain usage is fine. */}
  <PaymentFields clientSecret={session.clientSecret} />
  {/* completionEndpoint finishes the tokenize-first flow automatically — no onServerCompletion. See §7. */}
  <PayButton onResult={(result) => showOutcome(result)}>Pay</PayButton>
</PayFanoutProvider>
```

- The client adapter takes **only** `environment` — it holds no key. The session's
  `clientSecret` is the `hostedTokenizationUrl` the iframe mounts from.
- The Hosted Tokenization iframe does not expose a per-field validity stream, so the adapter
  fires `onChange({ complete: false })` once on mount and degrades gracefully. The true
  decline outcome surfaces **server-side** at completion (step 7).

::: tip Content-Security-Policy
A CSP-enforcing page must allow the Worldline payment host, or the iframe fails quietly:

```
script-src  https://payment.preprod.direct.worldline-solutions.com https://payment.direct.worldline-solutions.com
frame-src   https://payment.preprod.direct.worldline-solutions.com https://payment.direct.worldline-solutions.com
connect-src https://payment.preprod.direct.worldline-solutions.com https://payment.direct.worldline-solutions.com
```

The `preprod` host is exercised only by `environment: "sandbox"`. Override the script URL with
the `sdkUrl` config field to pin a version or self-host.
:::

## 6. 3-D Secure

Pass a `returnUrl` on `createPaymentSession` and the adapter forwards it as
`cardPaymentMethodSpecificInput.returnUrl` (the field the Hosted Tokenization guide names)
and in its `threeDSecure.redirectionData.returnUrl` form — both are current. A frictionless
authentication completes inline; a challenge comes back as `requires_action` with the
redirect URL on `PaymentInfo.raw` (`merchantAction.redirectData.redirectURL`). After the
customer returns, reconcile the outcome with `retrievePayment`.

## 7. The server-completion route (Worldline-only)

This is the step Stripe doesn't have. When the client tokenizes, the library POSTs the
resulting `clientToken` (the `hostedTokenizationId`, with the session reference and any
completion-time `billingDetails`) to your `completionEndpoint`, where you mount
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

Use your Worldline test account's documented sandbox cards and amount-based response triggers.
Commonly available test cards include Visa `4330 2649 3634 4675`, Mastercard
`5137 0098 0194 3438`, and Amex `3714 4963 5311 004`; **confirm the current list, decline
triggers, and 3-D Secure test cards in your Worldline documentation** rather than assuming.

## 10. Go live

- [ ] Swap in the **live** API key id + secret and the **live** merchant id.
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
