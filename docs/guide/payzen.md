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
| `paymentMethods` | - | card only | Capability declaration for router screening and `paymentMethodTypes` validation. Wallets/APMs are per-shop contracts, so they default to `supported: false` — override once the Back Office lists them (see §6). |
| `requestTimeoutMs` | - | `30000` | Abort a hung connection; surfaces as `psp_unavailable` (non-retryable on refund/cancel/validate — see §10). |
| `maxNetworkRetries` | - | `2` | Transport trouble only (network/timeout/5xx/429). PayZen answers HTTP 200 even for errors, so business errors never retry — and refund/cancel/validate calls are **never** auto-retried at all (see §10). |

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
- The card-only embedded form shown here is the default. To present several payment
  methods (Apple Pay, PayPal, …) with PayZen's smartForm, see §6 — submission ownership
  changes there, so read it before adding `form: "smartform"`.

::: tip Content-Security-Policy
krypton-client loads from `https://static.payzen.eu` — if you set a CSP, allow it under
`script-src`/`style-src`, plus a `frame-src` entry for the hosted-field/3DS iframe hosts
your form actually uses (watch the console in TEST mode; hosts vary per platform).
Override the URLs via `scriptUrl` / `cssUrl` (your Back Office "JavaScript URL").
:::

## 6. Offer several payment methods (smartForm)

PayZen's **smartForm** presents a payment-method list — cards plus, per your shop's
Back Office contracts, Apple Pay, PayPal, Bizum, Alma, meal-voucher cards, … — inside
the same embedded surface, and the buyer completes without leaving your site. Three
opt-in pieces, all backward compatible (the default stays the card-only embedded form):

**1. Declare the shop's contracts on BOTH adapters.** Wallets/APMs are per-shop
contracts, so the adapters ship a conservative card-only declaration; override it
once the Back Office lists the contract:

```ts
const methods = [
  { type: "card", flow: "embedded", supported: true },
  { type: "paypal", flow: "popup", supported: true },
  { type: "apple_pay", flow: "popup", supported: true },
] as const;

new PayZenServerAdapter({ /* …§4… */ paymentMethods: [...methods] });
new PayZenClientAdapter({ /* …§5… */ form: "smartform", paymentMethods: [...methods] });
```

**2. Choose the session's methods server-side.** `paymentMethodTypes` maps onto
PayZen's `paymentMethods` field (`card` → `CARDS`, `apple_pay` → `APPLE_PAY`,
`paypal` → `PAYPAL`); a single entry renders that method's entry page directly.
Omit it and PayZen offers **every** method the shop is eligible for (currency,
amount, and contract constraints applied by the platform):

```ts
const session = await payments.createPaymentSession({
  amount: 4990,
  currency: "EUR",
  paymentMethodTypes: ["card", "paypal"], // optional restriction
  idempotencyKey: "order-1-attempt-1",
});
```

**3. Render the smartForm and await the outcome.** Set `form: "smartform"` (method
list) or `"smartform-expanded"` (card fields pre-expanded in the list). The smartForm
renders its **own** pay buttons — Apple Pay requires the buyer's gesture, and each
method drives its own flow — so do **not** render `<PayButton>`. Instead, start
awaiting the buyer's in-form completion once the fields are ready:

```tsx
const { status } = usePayFanout();
const { pay } = usePay();
const awaiting = useRef(false);

useEffect(() => {
  if (status !== "ready" || awaiting.current) return;
  awaiting.current = true;
  void pay().then((result) => {
    awaiting.current = false;
    showOutcome(result); // on a failed retryable outcome, call pay() again to keep awaiting
  });
}, [status, pay]);

<PaymentFields clientSecret={session.clientSecret} />;
```

A completion that lands before your `pay()` call is buffered and returned by it, so
the race is safe. Local validation errors, integration warnings, and an abandoned 3DS
pop-in surface via `onError` while the await continues (the buyer is still in front
of a usable form); gateway rejections and fatal client errors settle it as `failed`.
The IPN remains the server-side source of truth either way.

Worth knowing:

- Recoverable in-form errors reach `onError`, and `<PaymentFields>` mirrors every
  `onError` into `usePayFanout().status = "error"` / `lastError` — so a buyer typo on
  the form's own pay button flips the provider status while the form stays usable and
  the await keeps running. Key banners or disabled states on the `pay()` outcome, not
  on `status`, in smartForm mode.
- A smartForm whose session/shop resolves to **cards only** renders the plain card
  fields directly — `form: "smartform"` is safe before any wallet contract exists.
- The **material theme is incompatible** with the smartForm (`CLIENT_505`); the
  default neon reset works.
- `payzenClient.fetchAvailablePaymentMethods()` returns the shop's **live** method
  list (via `KR.getPaymentMethods()`) as `{ types, methods, cardBrands }` — build a
  dynamic method chooser from it instead of hard-coding enablement.
- Apple Pay works in production only in Safari on Apple devices; TEST mode simulates
  it on other browsers.

## 7. Pay by bank — SEPA and the other bank rails (hosted redirect)

PayZen's bank rails live on its **hosted payment page**, not in the embedded/smartForm
surface. The adapter reaches them through a payment order (`Charge/CreatePaymentOrder`,
URL channel): the session's `clientSecret` becomes the hosted page URL, `confirm()` is
the redirect, and the outcome comes back server-side. The unified types map onto the
documented method codes:

| `paymentMethodTypes` entry | PayZen method(s) | Currencies | Customer countries | Refund | Cancel |
| --- | --- | --- | --- | --- | --- |
| `sepa_debit` | SEPA Direct Debit (`SDD`) — one-off mandate signed on the page | EUR | SEPA zone (undeclared — zone membership drifts) | by wire transfer | ✅ before capture |
| `ideal` | iDEAL (`IDEAL`) | EUR | NL | ✅ | ❌ (immediate capture) |
| `bank_redirect_generic` | the pay-by-bank family: SEPA Credit Transfer via payment initiation (`IP_WIRE`, `IP_WIRE_INST`), MyBank (`MYBANK`), Przelewy24 (`PRZELEWY24`) — the buyer picks on the page | EUR (P24 also PLN) | FR / ES, GR, IT / PL | rail-dependent (wire transfers: ❌) | ❌ |
| `voucher_generic` | Multibanco (`MULTIBANCO`) — reference paid out of band | EUR | PT | ❌ | ❌ |

Each rail needs its own Back Office contract, so all four default to
`supported: false` — declare what your shop has on **both** adapter configs, exactly
like the smartForm wallets in §6:

```ts
const methods = [
  { type: "card", flow: "embedded", supported: true },
  { type: "sepa_debit", flow: "redirect", supported: true, currencies: ["EUR"] },
  { type: "ideal", flow: "redirect", supported: true, currencies: ["EUR"], countries: ["NL"] },
] as const;
```

Then request a session with the rail and a `returnUrl` (required — the hosted page
sends the buyer back to it), and drive the standard redirect flow:

```tsx
// server
const session = await payments.createPaymentSession({
  amount: 2500,
  currency: "EUR",
  paymentMethodTypes: ["sepa_debit"],
  returnUrl: "https://shop.example/checkout/return",
  idempotencyKey: "order-9-attempt-1",
});
// session.status === "requires_action"; session.clientSecret is the hosted page URL

// client — <PaymentFields> renders an informational panel (customize via
// fieldOptions.description / appearance.panel); the pay button redirects.
<PaymentFields clientSecret={session.clientSecret} />
<PayButton onResult={showOutcome}>Pay by bank</PayButton>

// on the returnUrl page: resolve the return trip
<RedirectReturn onResult={(result) => refreshOrder(result)} />
```

What to expect operationally:

- **The IPN and `retrievePayment` are the source of truth.** The return trip resolves
  a kr-shaped return to a UX-grade outcome and everything else to `processing` — the
  hosted page's return data is display-only by design. Register the notification URL in
  the Back Office **REST API** section (§8), same as for the embedded form.
- **A session cannot mix surfaces**: bank rails and embedded methods (card, wallets)
  take separate sessions — the adapter rejects a mixed `paymentMethodTypes` list.
- **SEPA Direct Debit is a deferred rail**: the mandate is signed on the page, capture
  follows the shop's capture delay (authorization stays valid 15 days), `captureMethod:
  "manual"` works (`Transaction/Validate`), `cancelPayment` voids before capture, and
  refunds go out as wire transfers.
- **Wire transfers (`IP_WIRE*`) sit in `WAITING_AUTHORISATION`** until the buyer's bank
  settles — treat `processing` as normal, and expect no refund or cancel channel.
- The payment order expires per the shop default (or 90 days max) — an expired order
  simply never produces a transaction; create a fresh session.
- Verify each rail end to end against your shop's TEST mode before enabling it in
  production: contract eligibility and the hosted page's method availability are
  per-shop facts the adapter cannot check for you.

## 8. Register the IPN (webhook) endpoint

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

## 9. Capture, cancel, refund semantics

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

## 10. Idempotency — PayZen has none; know what the adapter synthesizes

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

## 11. Currencies

Amounts are integer minor units everywhere, including 0-decimal (JPY, KRW, XOF, XPF)
and 3-decimal (KWD, TND) currencies. Three deliberate gaps, rejected locally with
`invalid_request`:

- **BHD** — not supported by the PayZen platform.
- **CNY** and **KHR** — PayZen prices them with one and zero fractional digits while
  ISO 4217 uses two; passing minor units through would shift the decimal point
  (4,000,000 minor units mean 40,000.00 KHR, but PayZen would read 4,000,000 riel).

Currencies outside your MID's contract need the shop's currency-conversion option, or
PayZen answers `PSP_610` ("no acceptance agreement").

## 12. Test cards

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

## 13. Limitations (by design)

- **Unified method types cover card, Apple Pay, and PayPal.** The smartForm can also
  offer the platform's other methods (Bizum, Alma, meal vouchers, …) when a session
  does not restrict `paymentMethodTypes` — but they have no unified type, so they
  cannot be requested individually and report as `paymentMethodType: "other"`.
- **No vaulting yet** (`supportsSavedPaymentMethods: false`). PayZen's
  `REGISTER_PAY`/token path is the documented route for a future version.
- **No verification-only flow** — `Charge/CreateToken` always stores an instrument.
- **No event polling / listing** — IPN is the only push channel and `Order/Get` is
  per-order.
- **No statement descriptor field** exists in V4 (descriptors are acquirer-contract
  matters); the session field is withheld rather than failing the payment.

## 14. Go live

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
