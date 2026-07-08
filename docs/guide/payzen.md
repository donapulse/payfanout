# Set up PayZen

PayZen (the Lyra-operated gateway, REST API V4) is a **confirm-on-client** PSP like
Stripe: your server creates a short-lived `formToken`, the browser's krypton-client form
collects the card and **creates the transaction itself**, with 3DS2 running inline in a
pop-in — no server-completion route, no redirect. Your server learns outcomes via the
IPN (webhook) and `retrievePayment`.

Two packages: [`@payfanout/adapter-payzen-server`](/guide/server) (holds your REST
password; **edge-runtime compatible**, WebCrypto only) and
[`@payfanout/adapter-payzen`](/guide/react) (browser-safe, holds only the public key).

::: warning PayZen details evolve
Endpoint hosts, Back Office menu names, and test-card lists change over time — and the
same engine runs under sister brands (Lyra Collect, Systempay, Sogecommerce, …) with
different hosts. The **field names and behavior below are exact** (read from the adapter
source), but re-verify credential locations and URLs against your own
[PayZen documentation](https://payzen.io/) before going live.
:::

## 1. Get your PayZen credentials

From the **Merchant Back Office** (Settings → Shop → REST API keys tab) — four keys, and
each validates something different:

| Credential | What it is | Used by |
| --- | --- | --- |
| **User** | Numeric shop id, Basic-auth username | server adapter (`shopId`) |
| **Password** (`testpassword_…` / `prodpassword_…`) | Basic-auth password for REST calls **and** the HMAC key that signs **IPN** kr-answers | server adapter (`password`) |
| **Public key** (`shopId:testpublickey_…`) | Client-side only, the `kr-public-key` for the form | client adapter (`publicKey`) |
| **HMAC-SHA-256 key** | Signs **browser-return** kr-answers | server adapter (`hmacKey`) |

The same tab lists your shop's **Server name** (REST endpoint) and **JavaScript URL**
(krypton-client) — pass them via `apiBaseUrl` / `scriptUrl` if they differ from the
payzen.eu defaults.

::: danger Test vs production is selected by the KEY, not the URL
PayZen has a single endpoint; the `testpassword_…` / `prodpassword_…` key family decides
which mode a call runs in. Both adapters still require an explicit
`environment: "sandbox" | "live"` and **refuse a key whose family contradicts it** — a
mismatch fails at startup, never at checkout. The documentation site publishes DEMO
store keys you can test with before your own shop exists.
:::

## 2. Install

```bash
# server
pnpm add @payfanout/server @payfanout/adapter-payzen-server
# client (React)
pnpm add @payfanout/react @payfanout/adapter-payzen react react-dom
```

krypton-client is **not** an npm dependency; the client adapter injects the script and
its stylesheet lazily on first mount.

## 3. Environment variables

```bash
# .env (server), never committed
PAYZEN_SHOP_ID=…                  # the numeric "User"
PAYZEN_PASSWORD=…                 # testpassword_… in sandbox
PAYZEN_HMAC_KEY=…                 # the HMAC-SHA-256 key (browser-return validation)

# client bundle, must be VITE_-prefixed to reach the browser
VITE_PAYZEN_PUBLIC_KEY=…          # shopId:testpublickey_…
```

## 4. Wire the server adapter

```ts
import { PaymentService } from "@payfanout/server";
import { PayZenServerAdapter } from "@payfanout/adapter-payzen-server";

const payzen = new PayZenServerAdapter({
  shopId: process.env.PAYZEN_SHOP_ID!,
  password: process.env.PAYZEN_PASSWORD!,     // string, or string[] while rotating
  environment: "sandbox",                     // validated against the key family
  hmacKey: process.env.PAYZEN_HMAC_KEY,       // optional: browser-return validation only
});

const payments = new PaymentService({ adapters: [payzen] });
```

| Field | Required | Default | Notes |
| --- | --- | --- | --- |
| `shopId` | ✅ | - | Back Office "User". |
| `password` | ✅ | - | REST password for the selected environment; also validates IPN signatures. `string[]` keeps old + new valid during a Back Office key regeneration (the first entry authenticates REST calls). |
| `environment` | ✅ | - | Exactly `"sandbox"` or `"live"`. The adapter refuses a password from the other family. |
| `hmacKey` | - | - | The HMAC-SHA-256 key; only needed to validate **browser-return** kr-answers. Accepts `string[]`. |
| `apiBaseUrl` | - | `https://api.payzen.eu/api-payment` | Your Back Office "Server name" + `/api-payment` — sister platforms differ. |
| `requestTimeoutMs` | - | `30000` | Abort a hung connection; surfaces as `psp_unavailable` (non-retryable on refund/cancel/validate — see §8). |
| `maxNetworkRetries` | - | `2` | Transport trouble only (network/timeout/5xx/429). PayZen answers HTTP 200 even for errors, so business errors never retry — and refund/cancel/validate calls are **never** auto-retried at all (see §8). |

::: tip Sessions are cheap and short-lived
`createPaymentSession` calls `Charge/CreatePayment` and returns the `formToken` as
`clientSecret`. A formToken **expires after ~15 minutes** and no transaction exists until
the customer pays — if one expires (client error `PSP_108`/`CLIENT_100`), just create a
fresh session. `updatePaymentSession` is unsupported (`supportsSessionUpdate: false`):
formTokens are immutable, so amend by creating a new session.
:::

## 5. Wire the client adapter

```tsx
import { PayFanoutProvider, PaymentFields, PayButton } from "@payfanout/react";
import { PayZenClientAdapter } from "@payfanout/adapter-payzen";

const payzen = new PayZenClientAdapter({
  publicKey: import.meta.env.VITE_PAYZEN_PUBLIC_KEY,  // shopId:testpublickey_…, browser-safe
  environment: "sandbox",
});

<PayFanoutProvider adapters={[payzen]} initialPsp="payzen">
  <PaymentFields clientSecret={session.clientSecret} onChange={({ complete }) => setPayEnabled(complete)} />
  <PayButton onResult={(result) => showOutcome(result)}>Pay</PayButton>
</PayFanoutProvider>
```

- Card number, expiry, and CVV render as **Lyra-hosted iframes** (SAQ-A eligible); 3DS2
  challenges run in an inline pop-in, never a navigation.
- The script loads in SPA mode (`kr-spa-mode`) and deliberately **without `async`**
  (PayZen documents that async loading breaks on older mobile browsers). KR is a single
  page-global: one PayZen form per page.
- `fieldOptions` passes through to `KR.setFormConfig` (`kr-placeholder-*`,
  `kr-hide-debug-toolbar`, …). Protected keys the host cannot override: `formToken`,
  `kr-public-key`, `kr-spa-mode`, and `language` when a `locale` is given.
- `appearance` has no JS hook on PayZen: krypton mirrors your page's CSS into its
  iframes automatically, so style the fields with plain CSS (or swap the `cssUrl`
  stylesheet).
- The signed browser answer is **not** verified client-side (the validation keys are
  server secrets) — treat the client outcome as UX feedback and confirm server-side via
  the IPN or `retrievePayment`.

::: tip Content-Security-Policy
krypton-client loads from `https://static.payzen.eu` — if you set a CSP, allow it under
`script-src`/`style-src`, plus a `frame-src` entry for the hosted-field/3DS iframe hosts
your form actually uses (watch the console in TEST mode; hosts vary per platform).
Override the URLs via `scriptUrl` / `cssUrl` (your Back Office "JavaScript URL").
:::

## 6. Register the IPN (webhook) endpoint

In the Back Office: Settings → Notification rules → **Instant Payment Notification URL at
the end of the payment** (enable the rules you care about — end of payment, cancellation,
refund/Back Office operations). The adapter also sends `ipnTargetUrl` per session when
you pass `webhookUrl` to `createPaymentSession`.

PayZen POSTs `application/x-www-form-urlencoded` with five `kr-*` fields. The signature
(`kr-hash`) is an HMAC-SHA-256 over the **raw `kr-answer` JSON string**, and the signing
key depends on the path:

| Delivery | `kr-hash-key` | Validated with |
| --- | --- | --- |
| IPN (server-to-server) | `"password"` | your REST `password` |
| Browser return (`KR.onSubmit` payload / return URL POST) | `"sha256_hmac"` | your `hmacKey` |

Two equivalent ingestion recipes — the adapter accepts both:

```ts
import { createAdapterWebhookHandler } from "@payfanout/server";
const payzenHook = createAdapterWebhookHandler(payzen, {
  onEvent: (event) => enqueue(event), // ack-fast: enqueue, dedupe by event.id
});

// Recipe A (preferred): parse the form, pass the kr-answer STRING as rawBody
// and the kr-hash fields as headers.
app.post("/webhooks/payzen", express.urlencoded({ extended: false }), async (req, res) => {
  const r = await payzenHook({
    rawBody: String(req.body["kr-answer"] ?? ""),
    headers: {
      "kr-hash": String(req.body["kr-hash"] ?? ""),
      "kr-hash-algorithm": String(req.body["kr-hash-algorithm"] ?? ""),
      "kr-hash-key": String(req.body["kr-hash-key"] ?? ""),
    },
  });
  res.status(r.status).end();
});

// Recipe B: hand over the whole raw urlencoded body — the adapter extracts
// kr-answer and the hash fields itself.
app.post("/webhooks/payzen", express.raw({ type: "application/x-www-form-urlencoded" }), async (req, res) => {
  const r = await payzenHook({ rawBody: req.body.toString("utf8"), headers: {} });
  res.status(r.status).end();
});
```

Notes that matter in production:

- **Event ids are synthesized** as `transactionUuid:detailedStatus` — PayZen has no
  event id, `kr-hash` regenerates on every redelivery, and a redelivery can carry a
  *changed* `detailedStatus` (which must NOT dedupe away). Store processed ids keyed on
  that composite.
- Answer 200 promptly; with the "automatic retry" rule enabled PayZen retries up to 4
  times on quarter-hour marks.
- An abandoned 3DS pop-in produces its `REFUSED` transaction **asynchronously, up to ~10
  minutes later, via IPN only** — don't expect the browser to report it.
- **No chargeback IPNs exist** — disputes appear only in Back Office reports, so
  `payment.chargeback*` events never occur for this adapter.
- Restrict ingress to PayZen's documented IPN source range (`194.50.38.0/24`) if you
  filter by IP.

## 7. Capture, cancel, refund semantics

- **Capture is automatic by default** (same-evening remittance, or `captureDelay`).
  `captureMethod: "manual"` maps to PayZen's manual-validation mode: the transaction
  lands in `AUTHORISED_TO_VALIDATE` (`requires_capture`) and `capturePayment` runs
  `Transaction/Validate` — validation releases the **full authorized amount** (no partial
  capture; a differing amount is rejected). Validate before the authorization expires or
  the transaction becomes `EXPIRED`.
- `cancelPayment` voids a not-yet-captured transaction (`Transaction/Cancel`). Captured
  payments can only be refunded (`invalid_request` with PayZen's `PSP_075` on `raw`).
- `refundPayment` with an `amount` creates a partial refund (`Transaction/Refund`, a new
  CREDIT transaction — its uuid is the `refundId`). A full refund uses PayZen's
  cancel-or-refund dispatch: not-yet-captured payments are **cancelled** instead (the
  result still reports honestly — the customer was never charged). Poll async refunds
  with `retrieveRefund(refundId)`.

## 8. Idempotency — PayZen has none; know what the adapter synthesizes

PayZen's V4 API has **no idempotency mechanism** (verified against the live gateway):
replaying an identical `Charge/CreatePayment` mints a new formToken, and replaying a
`Transaction/Refund` **stacks a second refund** while the total stays within the
original. The adapter narrows the blast radius:

- `createPaymentSession` derives the `orderId` **deterministically** from your
  `idempotencyKey` (prefixed `pf-`, sanitized to PayZen's charset, ≤ 64 chars) and stamps
  `metadata.payfanout_key` / `metadata.payfanout_id` onto the transaction. Replays
  converge on the same order and stay reconcilable via `retrievePayment(orderId)`; the
  extra formTokens are inert.
- Refund/cancel/validate calls are **never auto-retried** at the transport level, and
  their transport failures (network error, timeout, 5xx, 429) surface
  `retryable: false` with re-read guidance — a lost response may mean the operation
  was applied, so nothing (including `withRetry`) may replay it blindly.
- **Never blind-retry `refundPayment`.** Re-read the payment first and check
  `amountRefunded`; the refund request has no field a replayed key could be matched
  against, so the adapter cannot detect duplicates for you.

## 9. Currencies

Amounts are integer minor units everywhere, including 0-decimal (JPY, KRW, XOF, XPF)
and 3-decimal (KWD, TND) currencies. Three deliberate gaps, rejected locally with
`invalid_request`:

- **BHD** — not supported by the PayZen platform.
- **CNY** and **KHR** — PayZen prices them with one and zero fractional digits while
  ISO 4217 uses two; passing minor units through would shift the decimal point
  (4,000,000 minor units mean 40,000.00 KHR, but PayZen would read 4,000,000 riel).

Currencies outside your MID's contract need the shop's currency-conversion option, or
PayZen answers `PSP_610` ("no acceptance agreement").

## 10. Test cards

In TEST mode the form shows a debug toolbar with an auto-fill "Test cards" tab (hide it
with `fieldOptions: { "kr-hide-debug-toolbar": true }`). Highlights from the
[official list](https://payzen.io/en-EN/rest/V4.0/api/kb/test_cards.html) — any future
expiry, any CVV; the card **number** selects the behavior (no amount-triggered declines):

| Card | Behavior |
| --- | --- |
| `4970100000000055` | Accepted (VISA) |
| `4970100000000113` | Refused |
| `4970110000001003` | Accepted after a 3DS challenge |
| `4970110000000039` | Refused after a 3DS challenge |
| `5970100300000067` | Accepted (Mastercard) |
| `4051700000003926` | Accepted in JPY |
| `4515450000004140` | Accepted in KWD |

## 11. Limitations (v1, by design)

- **Card only.** SmartForm wallets/APMs (Apple Pay, PayPal, …) use a different form mode
  and per-contract enablement — not exposed yet.
- **No vaulting yet** (`supportsSavedPaymentMethods: false`). PayZen's
  `REGISTER_PAY`/token path is the documented route for a future version.
- **No verification-only flow** — `Charge/CreateToken` always stores an instrument.
- **No event polling / listing** — IPN is the only push channel and `Order/Get` is
  per-order.
- **No statement descriptor field** exists in V4 (descriptors are acquirer-contract
  matters); the session field is withheld rather than failing the payment.

## 12. Go live

- [ ] Complete PayZen's mandatory test payments, then generate the **production**
      password + HMAC key in the Back Office.
- [ ] Swap in `prodpassword_…`, the production public key, and set
      `environment: "live"` on **both** adapters (the adapters refuse mismatched
      families).
- [ ] Configure the **PRODUCTION** IPN URL (test and production rules are separate).
- [ ] Make the required real ≥ 2 EUR payment and verify the IPN shows "Sent" in the
      Back Office.
- [ ] Verify card fields are still the Lyra-hosted iframes (SAQ-A), no raw card input.

Then continue with [Server usage](/guide/server), [React usage](/guide/react), and
[Webhooks](/guide/webhooks).
