# Set up Paysafe

Paysafe is a **tokenize-first** PSP: the browser tokenizes the card into a single-use
handle, then your **server** finalizes the charge with that handle. This inverts Stripe's
flow, and PayFanout models both as first-class, the React code is identical, but Paysafe
needs one extra thing Stripe doesn't: a **server-completion route** (step 7).

Two packages: [`@payfanout/adapter-paysafe-server`](/guide/server) (holds your API
credentials; **edge-runtime compatible**, WebCrypto only, runs on Cloudflare Workers /
Next.js edge) and [`@payfanout/adapter-paysafe`](/guide/react) (browser-safe, holds only
the public tokenization key).

::: warning Paysafe API details evolve
Endpoint hosts, portal menu names, webhook header names, and test-card lists change over
time and vary per merchant account. The **field names and behavior below are exact**
(read from the adapter source), but re-verify credential locations and test cards against
your own [Paysafe developer portal](https://developer.paysafe.com) before going live.
:::

## 1. Get your Paysafe credentials

From the **Paysafe Merchant / Business Portal** (its API-credentials and account sections):

| Credential | What it is | Used by |
| --- | --- | --- |
| **API username + password** | Payments REST API Basic-auth credentials (server-only) | server adapter (`username`, `password`) |
| **Public single-use-token key** | Base64 API key that can *only* mint single-use card tokens, browser-safe | client adapter (`apiKey`) |
| **Merchant account id(s)** | One per currency/country your account is provisioned for | server adapter (`merchantAccountResolver`) |
| **Webhook HMAC key** | Signs webhook payloads; configured with your notification endpoint | server adapter (`webhookHmacKey`) |

Sandbox and live are **separate credential sets** and **separate hosts**, the adapter
derives the host from `environment` (`sandbox → api.test.paysafe.com`,
`live → api.paysafe.com`).

::: danger One secret you generate yourself
`sessionSigningKey` is **not issued by Paysafe.** Because PayFanout is stateless, the
Paysafe "session" is a **signed, self-contained token**, amount, currency, and account id
are HMAC-signed into it so the browser can round-trip it but cannot tamper with the amount.
That HMAC key is **yours**. Generate a strong random secret once and keep it stable:

```bash
openssl rand -hex 32   # → PAYSAFE_SESSION_KEY
```

If it changes (or differs between server instances), previously issued sessions fail
signature verification at completion. The client adapter only reads the payload half and
never needs this key.
:::

## 2. Install

```bash
# server
pnpm add @payfanout/server @payfanout/adapter-paysafe-server
# client (React)
pnpm add @payfanout/react @payfanout/adapter-paysafe react react-dom
```

Paysafe.js is **not** an npm dependency; the client adapter injects it lazily from Paysafe's
CDN on first mount.

## 3. Environment variables

```bash
# .env (server), never committed
PAYSAFE_USERNAME=…
PAYSAFE_PASSWORD=…
PAYSAFE_ACCOUNT_ID=…              # a merchant account id (omit if your key is single-account)
PAYSAFE_SESSION_KEY=…             # YOUR secret, openssl rand -hex 32 (not from Paysafe)
PAYSAFE_WEBHOOK_HMAC_KEY=…

# client bundle, must be VITE_-prefixed to reach the browser
VITE_PAYSAFE_PUBLIC_KEY=…         # the public single-use-token Base64 key
VITE_PAYSAFE_CURRENCY=CAD         # match your sandbox account's currency (see §9)
```

Env-var names deliberately **differ** from config field names, e.g. `PAYSAFE_SESSION_KEY`
feeds `sessionSigningKey`, `PAYSAFE_WEBHOOK_HMAC_KEY` feeds `webhookHmacKey`.

## 4. Wire the server adapter

```ts
import { PaymentService } from "@payfanout/server";
import { PaysafeServerAdapter } from "@payfanout/adapter-paysafe-server";

const paysafe = new PaysafeServerAdapter({
  username: process.env.PAYSAFE_USERNAME!,
  password: process.env.PAYSAFE_PASSWORD!,
  environment: "sandbox",                                  // → api.test.paysafe.com
  // Paysafe accounts are per currency/country. Return undefined for a single-account
  // key and Paysafe routes by key + currency:
  merchantAccountResolver: (currency, country) => process.env.PAYSAFE_ACCOUNT_ID,
  sessionSigningKey: process.env.PAYSAFE_SESSION_KEY!,     // YOUR HMAC secret, not a Paysafe credential
  webhookHmacKey: process.env.PAYSAFE_WEBHOOK_HMAC_KEY!,   // string, or string[] while rotating
});

const payments = new PaymentService({ adapters: [paysafe] });
```

| Field | Required | Default | Notes |
| --- | --- | --- | --- |
| `username` / `password` | ✅ | - | Basic-auth REST API credentials. Server-only. |
| `environment` | ✅ | - | Exactly `"sandbox"` or `"live"`; selects the API host. Never inferred. |
| `merchantAccountResolver` | ✅ | - | `(currency, country?) => accountId \| undefined`. Must be a function. Return `undefined` for single-account keys. |
| `sessionSigningKey` | ✅ | - | HMAC key for the stateless signed session. **You generate this.** Keep it stable across restarts/instances. |
| `webhookHmacKey` | ✅ | - | Paysafe's webhook signing key. Pass a **`string[]`** to rotate with no cutover. |
| `sessionTtlSeconds` | - | `3600` | How long a signed session stays completable (1h). Enforced at completion. |
| `requestTimeoutMs` | - | `30000` | Abort a hung Paysafe connection; surfaces as a retryable `psp_unavailable`. |
| `maxNetworkRetries` | - | `2` | Retries transport trouble (network/timeout/5xx/429) only, never business errors like declines. |

::: tip `createPaymentSession` makes no network call
For Paysafe it just mints and signs the self-contained session token locally, the first
real API call is `completePayment` (step 7). That is why the session must carry everything
completion needs, signed.
:::

## 5. Wire the client adapter

```tsx
import { PayFanoutProvider, PaymentFields, PayButton } from "@payfanout/react";
import { PaysafeClientAdapter } from "@payfanout/adapter-paysafe";

const paysafe = new PaysafeClientAdapter({
  apiKey: import.meta.env.VITE_PAYSAFE_PUBLIC_KEY,  // public single-use-token key, browser-safe
  environment: "sandbox",                            // → Paysafe.js "TEST"
});

<PayFanoutProvider adapters={[paysafe]} initialPsp="paysafe">
  <PaymentFields clientSecret={session.clientSecret} onChange={({ complete }) => setPayEnabled(complete)} />
  <PayButton
    onResult={(result) => showOutcome(result)}
    onServerCompletion={(clientToken) => postToMyApi("/api/complete", { clientToken })} // REQUIRED, see §7
  >
    Pay
  </PayButton>
</PayFanoutProvider>
```

- `apiKey` must be the **public** Base64 tokenization key, never the server
  username/password. It can only mint single-use tokens and holds no secret authority.
- **Currency comes from the signed session**, not from client config. It must be a currency
  your Paysafe account supports, or Paysafe.js fails to set up (error `9055`). See §9.
- Split card fields let you own the layout via slots
  (`data-payfanout-field="cardNumber|expiryDate|cvv"`), see [React usage](/guide/react).

::: tip Content-Security-Policy
Paysafe.js loads from `https://hosted.paysafe.com`. If you set a CSP, allow
`script-src https://hosted.paysafe.com` and `frame-src https://hosted.paysafe.com`. Override
the URL via the `sdkUrl` config field to pin/self-host.
:::

## 6. Billing postal code is required

Browser-tokenized handles carry no AVS data, so Paysafe rejects card charges without a
billing postal/ZIP code (error `3004`). Supply `billingDetails.address` on
`createPaymentSession` (the demo always does).

## 7. The server-completion route (Paysafe-only)

This is the step Stripe doesn't have. When the client tokenizes, `<PayButton>` hands the
resulting `clientToken` to your `onServerCompletion` callback, which **POSTs to your own
API route**. That route calls `completePayment`, the server-side finalization:

```ts
// POST /api/complete  (your route)
app.post("/api/complete", express.json(), async (req, res) => {
  const info = await payments.completePayment("paysafe", {
    pspSessionId: req.body.pspSessionId,   // the signed session id from createPaymentSession
    clientToken: req.body.clientToken,     // the single-use handle from the browser
    idempotencyKey: req.body.orderId,      // required
  });
  res.json(info);
});
```

`completePayment` verifies the session signature and expiry, then charges. Calling it on a
confirm-on-client PSP (Stripe) throws, it exists only for tokenize-first PSPs
(`requiresServerCompletion: true`). See [React usage](/guide/react#the-two-completion-shapes).

## 8. Register the webhook endpoint

::: warning Configured in the portal, not via the API
Paysafe's `POST /payments` **rejects** webhook/return-link fields (error `5023`), so you
register your notification endpoint URL and its **HMAC key** in the Paysafe portal, not in
code. PayFanout only *verifies* what Paysafe sends.
:::

Point the portal's notification endpoint at `https://your-api.example/webhooks/paysafe`,
copy the HMAC key into `PAYSAFE_WEBHOOK_HMAC_KEY`, and mount the handler with the **raw
body** (signature verification hashes the exact bytes):

```ts
import { createAdapterWebhookHandler } from "@payfanout/server";
const paysafeHook = createAdapterWebhookHandler(paysafe, {
  onEvent: (event) => enqueue(event), // ack-fast: enqueue, dedupe by event.id; never process inline
});

app.post("/webhooks/paysafe", express.raw({ type: "application/json" }), async (req, res) => {
  const r = await paysafeHook({ rawBody: req.body.toString("utf8"), headers: req.headers });
  res.status(r.status).end();
});
app.use(express.json()); // AFTER the webhook route
```

Paysafe **retries effectively forever** until it sees a 2xx, so your `onEvent` must enqueue
and return fast. Paysafe has no public events-polling API
(`supportsEventPolling: false`), for missed-webhook recovery, reconcile with
`retrievePayment` per order. See [Webhooks](/guide/webhooks).

## 9. Test cards & the sandbox-currency trap

::: danger Match your account's currency
Paysafe sandbox accounts are usually provisioned for a **single currency** (the reference
test account is **CAD-only**). If your session currency doesn't match, Paysafe.js fails at
mount with error `9055`. Set `VITE_PAYSAFE_CURRENCY` (client), and `PAYSAFE_CURRENCY` for
saved-token/subscription charges (server), to your account's currency.
:::

Use your Paysafe test account's documented sandbox cards, the exact set (and, for many
accounts, an **amount-based** response simulator that triggers declines/3DS by transaction
amount) depends on your account configuration. A commonly available test Visa is
`4111 1111 1111 1111`; **confirm the current list, decline triggers, and 3DS test cards in
your Paysafe portal** rather than assuming.

## 10. Go live

- [ ] Swap in the **live** API username/password and the **live** public tokenization key.
- [ ] Set `environment: "live"` on **both** adapters (host flips to `api.paysafe.com`).
- [ ] Confirm your **live** merchant account ids per currency/country and that
      `merchantAccountResolver` returns them.
- [ ] Register the **live** notification endpoint in the portal and use its **live** HMAC
      key.
- [ ] Keep `PAYSAFE_SESSION_KEY` stable and secret in production, rotate it deliberately
      (it invalidates in-flight sessions), and store it like any other secret.
- [ ] Verify card fields are still the Paysafe.js hosted iframes (SAQ-A), no raw card input.
- [ ] Re-check endpoint paths, webhook header names, and error codes against the current
      Paysafe developer portal.

Then continue with [Server usage](/guide/server), [React usage](/guide/react), and
[Webhooks](/guide/webhooks).
