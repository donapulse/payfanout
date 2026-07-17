# PayFanout

Unified multi-PSP payment abstraction for React + TypeScript. One consistent API and one
set of embedded UI components over multiple Payment Service Providers, application code
never knows which PSP is active. PayFanout is provider-agnostic: implement any payment gateway
by writing a new adapter package only, **zero changes to core, zero
changes to consuming application code**, verified by a shared conformance suite.

**Documentation:** guides and the full API reference live at
**<https://donapulse.github.io/payfanout/>**.

> **PayFanout is stateless. It has no database and persists nothing.**
> The consuming application owns:
> - the mapping between its internal payment/order ids and `pspPaymentId`s,
> - the webhook event dedupe store ("have I processed this event id"),
> - any audit/event log.
>
> PayFanout's job is orchestration + normalization only. If you are looking for where
> PayFanout stores a payment, it doesn't. See `examples/demo/server.mts` for what the
> host app is expected to keep.

Two more non-negotiables baked into the design:

- **We never store card data, and neither do you.** Card capture happens exclusively in
  each PSP's hosted surface (Stripe's Payment Element, Paysafe.js fields, PayZen's
  krypton form, Worldline's Hosted Tokenization iframe — all SAQ-A eligible); there
  is no raw card `<input>` anywhere. Saved cards / recurring payments (below) change
  nothing about this: the **PSP** vaults the card and hands back an opaque token, your
  database stores that token exactly like it stores a `pspPaymentId`, never a PAN.
- **Payment flows are modeled honestly.** Embedded card fields render in your UI, styled
  by your design tokens, and 3DS/SCA challenges run inline (iframe/modal). Genuinely
  redirect/voucher payment methods (iDEAL, PaysafeCard, Skrill…) are modeled via the
  `flow` capability field, never forced into an embedded illusion.

## Packages

| Package | Runs | Purpose |
| --- | --- | --- |
| `@payfanout/core` | anywhere | Unified domain model, adapter contracts, currency + error + refund-state helpers. Zero dependencies, zero PSP code. |
| `@payfanout/server` | server | `PaymentService` over an adapter registry + framework-agnostic webhook handlers. |
| `@payfanout/react` | client | `<PayFanoutProvider>`, `usePayFanout`, `<PaymentFields>`, `<PayButton>`. |
| `@payfanout/adapter-stripe-server` | server | Stripe Node SDK: PaymentIntents, refunds, webhook verification. **Pins an explicit `apiVersion`.** |
| `@payfanout/adapter-stripe` | client | Stripe.js + Payment Element. |
| `@payfanout/adapter-paysafe-server` | server | Paysafe Payments REST API: payments, settlements, refunds, webhooks. **Edge-runtime compatible** (WebCrypto, no Node builtins), runs on Cloudflare Workers / Next.js edge routes. |
| `@payfanout/adapter-paysafe` | client | Paysafe.js hosted iframe fields (tokenize-first). |
| `@payfanout/adapter-gocardless-server` | server | GoCardless Billing Requests REST API: billing requests + hosted bank authorisation, refunds, events, batched webhooks. **Edge-runtime compatible** (WebCrypto, no Node builtins). |
| `@payfanout/adapter-gocardless` | client | GoCardless bank payments via the hosted authorisation redirect flow (no card fields). |
| `@payfanout/adapter-paypal-server` | server | PayPal Orders v2 REST: capture/authorize, refunds, webhook postback verification, event polling. **Edge-runtime compatible** (fetch + WebCrypto, no Node builtins). |
| `@payfanout/adapter-paypal` | client | PayPal Buttons: popup approval, no card fields (tokenize-first). |
| `@payfanout/adapter-payzen-server` | server | PayZen (Lyra) REST API V4: payments, validation capture, refunds, IPN verification. **Edge-runtime compatible** (WebCrypto, no Node builtins). |
| `@payfanout/adapter-payzen` | client | PayZen krypton-client embedded card fields (confirm-on-client, 3DS inline). |
| `@payfanout/adapter-worldline-server` | server | Worldline Direct Online Payments REST v2: Hosted Tokenization, payments, captures, refunds, webhooks. **Edge-runtime compatible** (WebCrypto, no Node builtins). |
| `@payfanout/adapter-worldline` | client | Worldline Direct Hosted Tokenization Page iframe (tokenize-first). |
| `@payfanout/conformance` | tests | The contract suite every adapter, present or future, must pass. |

Client packages have **zero** dependency on anything holding secrets; this is enforced
mechanically by `scripts/check-boundaries.mjs` (part of `pnpm run check`), not by
convention. Every adapter config requires an explicit `environment: "sandbox" | "live"`,
never inferred from key prefixes.

> **Installing & wiring a specific PSP?** The step-by-step setup guides, credentials from
> each dashboard, both adapter halves, webhook registration, test values, and go-live, live
> on the docs site:
> [Stripe](https://donapulse.github.io/payfanout/guide/stripe) ·
> [Paysafe](https://donapulse.github.io/payfanout/guide/paysafe) ·
> [GoCardless](https://donapulse.github.io/payfanout/guide/gocardless) ·
> [PayPal](https://donapulse.github.io/payfanout/guide/paypal) ·
> [PayZen](https://donapulse.github.io/payfanout/guide/payzen) ·
> [Worldline](https://donapulse.github.io/payfanout/guide/worldline)
> ([overview](https://donapulse.github.io/payfanout/guide/providers)). Installing a PSP we
> don't ship yet: [adapter authoring](https://donapulse.github.io/payfanout/adapter-authoring).
> The quick starts below are the condensed version.

## Server quick start

```ts
import { PaymentService, createAdapterWebhookHandler } from "@payfanout/server";
import { StripeServerAdapter } from "@payfanout/adapter-stripe-server";
import { PaysafeServerAdapter } from "@payfanout/adapter-paysafe-server";

const stripe = new StripeServerAdapter({
  secretKey: process.env.STRIPE_SECRET_KEY!,
  apiVersion: "2024-06-20",            // pinned, required
  webhookSigningSecret: process.env.STRIPE_WEBHOOK_SECRET!,
  environment: "sandbox",
});

const paysafe = new PaysafeServerAdapter({
  username: process.env.PAYSAFE_USERNAME!,
  password: process.env.PAYSAFE_PASSWORD!,
  environment: "sandbox",
  merchantAccountResolver: (currency, country) => lookupAccount(currency, country), // per currency/country, required
  sessionSigningKey: process.env.PAYSAFE_SESSION_KEY!,   // signs the stateless session context
  webhookHmacKey: process.env.PAYSAFE_WEBHOOK_HMAC_KEY!,
});

const payments = new PaymentService({ adapters: [stripe, paysafe] });

// One unified API, PSP named per call (PayFanout keeps no id mapping, you do):
const session = await payments.createPaymentSession("stripe", {
  id: order.id,                 // your id; round-tripped via PSP metadata where supported
  amount: 1099,                 // ALWAYS integer minor units at this boundary
  currency: "USD",
  idempotencyKey: order.id,     // required on every mutating call
  // Optional checkout fields (mapped per PSP, validated locally where possible):
  statementDescriptor: "MYSHOP ORDER",   // bank-statement text
  receiptEmail: "buyer@example.com",
  shippingDetails: { name: "A. Buyer", address: { line1: "1 Way", postalCode: "10001", country: "US" } },
  sca: { challenge: "force" },           // or { exemption: "moto" }, best-effort per PSP
});
// -> session.clientSecret goes to the client
// Cart changed before confirmation? updatePaymentSession amends it (Stripe: in place;
// Paysafe: re-issues the signed context, ALWAYS continue with the returned session).
// later: retrievePayment / capturePayment / cancelPayment / refundPayment /
//        retrieveRefund (poll "pending" refunds) / verifyPaymentMethod /
//        fetchEvents / listPayments / listRefunds (capability-gated passthroughs)
// PaymentInfo now carries receipt-grade facts once the PSP reports them:
//   paymentMethodDetails ({ brand: "visa", last4: "4242", wallet? }) and
//   mandateReference (SEPA/ACH/BACS mandate id, quote it to the customer).
```

### Routing & failover (multi-PSP for a reason)

`PaymentRouter` picks the PSP per payment and cascades transient failures, session
creation only; every later call stays pinned to the PSP that won:

```ts
import { PaymentRouter } from "@payfanout/server";

const router = new PaymentRouter({
  service: payments,
  rules: [
    { when: { currency: ["CAD"] }, use: ["paysafe", "stripe"] },  // primary, then failover
    { when: { currency: ["EUR", "GBP"] }, use: ["stripe"] },
  ],
});
const { session, pspName, attempts } = await router.createPaymentSession(input);
```

Candidates that can't serve the input (no manual capture, unsupported method types…) are
skipped without a PSP call; business rejections (`invalid_request`, `card_declined`)
abort the cascade, only transient trouble (`psp_unavailable`, `rate_limited`,
`processing_error`, or `retryable` errors) fails over. `attempts` is your audit trail.
A **circuit breaker** (on by default, configurable via `circuitBreaker`) remembers
outages: after 5 consecutive transient failures a PSP is skipped without paying its
latency, half-opens after 30s for a probe, and closes on any response that proves it
alive. If *every* candidate is open, they are attempted anyway, the breaker never
turns an outage into a self-inflicted hard-down.

### Saved cards & recurring payments

Vaulting is **PSP-side only**: create a customer, save the card with the customer's
consent during a normal checkout, then charge the stored token off-session, no card
fields, no customer present:

```ts
const customer = await payments.createCustomer("stripe", { id: user.id, email, idempotencyKey });
// checkout with consent (the "save my card" checkbox is YOUR UI):
//   Stripe: createPaymentSession({ ..., customer: customer.pspCustomerId, savePaymentMethod: true })
//           -> after confirmation, PaymentInfo.savedPaymentMethodToken is the stored token
//   Paysafe (tokenize-first): savePaymentMethod(psp, { pspCustomerId, clientToken }) converts the
//           client's single-use token into a permanent one, then charge it
const info = await payments.chargeSavedPaymentMethod("stripe", {
  pspCustomerId: customer.pspCustomerId,
  savedPaymentMethodToken: token,      // stored in YOUR db, opaque, never card data
  amount: 1099, currency: "USD",
  occurrence: "recurring",             // honest credential-on-file flags (initial/recurring/unscheduled)
  idempotencyKey,
});
// listSavedPaymentMethods / deleteSavedPaymentMethod complete the lifecycle.
```

**Subscriptions** ride on top via `SubscriptionManager`, PayFanout supplies the billing
logic (period math with calendar-safe anchors, deterministic renewal idempotency,
retry/dunning, status transitions), the HOST supplies storage (implement
`SubscriptionStore` over your database) and a cron:

```ts
import { SubscriptionManager } from "@payfanout/server";
const subs = new SubscriptionManager({ service: payments, store: myDbStore });
await subs.createSubscription({ pspName, pspCustomerId, savedPaymentMethodToken,
  plan: { amount: 1099, currency: "USD", interval: "month" }, idempotencyKey });
// your cron, every few minutes:
await subs.chargeDueSubscriptions();   // renews, retries (24h/72h dunning), cancels when exhausted
// retrieveSubscription / listSubscriptions / updateSubscription / cancelSubscription({ atPeriodEnd })
```

Off-session charges that hit a bank's authentication demand surface as
`authentication_required`, bring the customer back on-session; the dunning schedule
handles the retries.

Providers with their own billing product are covered too: capability-gated
`listNativeSubscriptions` / `retrieveNativeSubscription` / `createNativeSubscription` /
`cancelNativeSubscription` passthroughs read and mutate **PSP-native** subscriptions as
unified records — the seam for adopting a merchant's existing PSP-billed subscriptions
into the host engine (list at the PSP, re-create locally on the same vault token, cancel
at the PSP with verified-idempotent semantics). Support is declared per operation in
`getCapabilities().nativeSubscriptions`; see the
[PSP-native subscriptions guide](https://donapulse.github.io/payfanout/guide/native-subscriptions).

### Retries, the machinery behind `retryable`

Idempotency keys are mandatory on every mutating call, so transient failures are safe
to replay. Three layers act on that: the Stripe SDK retries network failures itself
(`maxNetworkRetries`, default 2); every REST adapter's transport (Paysafe, GoCardless,
PayPal, PayZen, Worldline) retries timeouts/5xx/429 with backoff (`maxNetworkRetries`,
business errors like declines are never replayed); and `withRetry(fn, policy)` from
`@payfanout/core` wraps any call with
exponential backoff + jitter for `PayFanoutError.retryable` rejections.

### Observability

`new PaymentService({ adapters, telemetry })` calls your hook after every adapter
operation with `{ pspName, operation, durationMs, ok, errorCode? }`, metadata only, no
amounts/ids/PII, and a throwing hook never affects the payment path. For logging raw PSP
payloads safely, `scrubForLogging(raw)` from `@payfanout/core` deep-redacts PII/card/token
fields and masks card-number-shaped strings.

**User-facing text ships localized.** PayFanout includes built-in **en / fr / de / es**
catalogs, so `localizeError(err, locale)` and `getUserMessage(code, locale)` from
`@payfanout/core` return translated, user-safe messages out of the box, an unknown code
or locale always falls back to English, so partial coverage is safe. Localize by CODE,
never by string-matching messages. Add a language or override any built-in string at the
edge with `registerErrorMessages(locale, catalog)`. The tiny bit of UI the library renders
itself (the default `<PayButton>` label) localizes the same way: pass
`<PayFanoutProvider locale="fr">` (or `registerUiLabels` / `getUiLabel` for your own
labels). `BUILT_IN_LOCALES` exposes the shipped catalogs. The demo app switches all four
languages at runtime.

Amounts are **integer minor units, always**, and minor units are currency-dependent,
JPY has 0 decimals (`¥500` → `500`), BHD has 3 (`BD 1.234` → `1234`). Use
`toMinorUnits(major, currency)` / `formatMinorUnits(minor, currency)` from
`@payfanout/core`; each adapter handles its PSP's quirks internally (e.g. Stripe requiring
three-decimal amounts to end in 0). Refund state is **derived**, never a payment status:
`getRefundState(info)` → `"none" | "partial" | "full"`.

Every failure from every adapter is a `PayFanoutError` (a real `Error` subclass): unified
`code` (`card_declined`, `insufficient_funds`, `rate_limited`, …), user-safe `message`,
`retryable` flag, and the untouched PSP error on `raw`, never dropped.

## React quick start

```tsx
import { PayFanoutProvider, PaymentFields, PayButton, usePayFanout } from "@payfanout/react";
import { StripeClientAdapter } from "@payfanout/adapter-stripe";
import { PaysafeClientAdapter } from "@payfanout/adapter-paysafe";

const adapters = [
  new StripeClientAdapter({ publishableKey: "pk_…", environment: "sandbox" }),
  new PaysafeClientAdapter({ apiKey: "base64-public-key", environment: "sandbox" }),
];

<PayFanoutProvider adapters={adapters} initialPsp="stripe">
  <PaymentFields
    clientSecret={session.clientSecret}
    appearance={designTokens}
    onChange={({ complete }) => setPayEnabled(complete)} // disable Pay until fields are valid
  />
  <PayButton
    onResult={(result) => …}
    onServerCompletion={(clientToken) =>
      // Only tokenize-first PSPs (Paysafe) invoke this: POST to YOUR route,
      // which calls payments.completePayment(psp, { pspSessionId, clientToken, idempotencyKey }).
      postToMyApi("/api/complete", { clientToken })
    }
  >
    Pay
  </PayButton>
</PayFanoutProvider>
```

SDKs load lazily, only the adapter actually mounted downloads its script. Everything is
SSR-safe (adapters are never touched during SSR); the components work as client
components under the Next.js App Router.

### Design-system customization (fully yours)

Four independent axes, all PSP-vocabulary passthroughs, present AND future SDK options
stay reachable without a library release:

```tsx
<PaymentFields
  clientSecret={session.clientSecret}
  appearance={tokens}                       // visual theme (Stripe Appearance API / Paysafe style map)
  locale="fr-CA"                            // the PSP's own field texts
  fieldOptions={{                           // the SDK's full UI option surface:
    layout: { type: "accordion" },          //   Stripe: layout, paymentMethodOrder,
    paymentMethodOrder: ["card", "sepa_debit"], //   fields, defaultValues, terms, wallets…
  }}
/>

// Split-field PSPs (Paysafe): YOUR layout via slots, any grid, rows, labels.
<PaymentFields clientSecret={secret} fieldOptions={{ fields: { cardNumber: { placeholder: "Numéro de carte" } } }}>
  <div className="my-grid">
    <div data-payfanout-field="cardNumber" />
    <div className="row">
      <div data-payfanout-field="expiryDate" />
      <div data-payfanout-field="cvv" />
    </div>
  </div>
</PaymentFields>

// Bring your own button, usePay() is <PayButton>'s engine as a hook:
const { pay, paying } = usePay({ onServerCompletion });
<MyDesignSystemButton loading={paying} onClick={async () => show(await pay())} />
```

Adapters keep only the keys they must own to function (Stripe: `clientSecret`;
Paysafe: environment/currency/account/mount selectors), everything else is yours.
The demo restyles them (accordion + method order on Stripe; French
placeholders + a two-column slot grid on Paysafe + a fully custom gradient button).

### The two completion shapes (§4a, designed in, not bolted on)

PSPs come with inverted flows, and the abstraction models both as first-class:

- **Confirm-on-client (Stripe, PayZen; GoCardless via its hosted redirect):** server
  creates the payment session → client mounts with `clientSecret` → `confirm()` finalizes
  (incl. inline 3DS). Done, the server never touches confirmation, and `completePayment`
  is rejected for such PSPs.
- **Tokenize-first (Paysafe, PayPal, Worldline):** the client tokenizes first (`confirm()`
  resolves `requires_confirmation` + `clientToken`), then the **server** finalizes via
  `completePayment`. `<PayButton>` branches automatically through your
  `onServerCompletion` callback; the UI code is identical either way.

Every tokenize-first PSP reuses the same path (`requiresServerCompletion: true`).

Because PayFanout is stateless, the Paysafe adapter's "session" is a **signed,
self-contained context**: amount/currency/merchant-account are HMAC-signed into
`pspSessionId` at session creation and verified at `completePayment`, the browser
round-trips the token but cannot tamper with the amount. Every context carries an
**expiry** (`sessionTtlSeconds`, default 1h) enforced at completion, a signed token is
never completable forever. The raw Paysafe transport also enforces a **network timeout**
(`requestTimeoutMs`, default 30s): a hung PSP connection surfaces as a retryable
`psp_unavailable` instead of hanging your request handler (safe, every mutating call
carries an idempotent `merchantRefNum`).

### Redirect payment methods: the return trip

Card fields render embedded, while genuinely redirect methods (iDEAL, bank redirects)
leave the page. Mount the return-trip helper on your `returnUrl` page, it probes every
registered client adapter, resolves the outcome, and reports the same `PayResult` as
`<PayButton>`:

```tsx
import { useRedirectReturn } from "@payfanout/react";
const { phase, result } = useRedirectReturn({ onResult: showOutcome });
// phase: "checking" | "none" (normal page load) | "complete"
```

Implemented for Stripe (`payment_intent_client_secret` params → real intent status,
not the `redirect_status` hint), GoCardless (hosted bank authorisation), and PayZen
(hosted-page bank rails). Paysafe wires the same probe: Interac e-Transfer ships
end-to-end (enable it on the account), while its other redirect methods (Skrill,
Neteller, vouchers) stay capability-off until an account with them enabled lets us
verify the return params (see docs/future-designs.md).

## Webhooks

Both ingress patterns are supported, output is always one normalized `UnifiedWebhookEvent`:

```ts
// 1. Recommended: one endpoint per adapter
const stripeHook = createAdapterWebhookHandler(stripe, { onEvent });
// 2. Single shared URL (tries each adapter's signature verification; logs which matched)
const unifiedHook = createUnifiedWebhookHandler([stripe, paysafe], { onEvent, log: console.log });
```

**⚠ Raw body required.** Signature verification hashes the exact raw request bytes.
`express.json()`, Next.js default body parsing, and most middlewares destroy them:

```ts
// Express, register BEFORE express.json():
app.post("/webhooks/stripe", express.raw({ type: "application/json" }), async (req, res) => {
  const result = await stripeHook({ rawBody: req.body.toString("utf8"), headers: req.headers });
  res.status(result.status).end();
});

// Next.js App Router:
export async function POST(req: Request) {
  const result = await stripeHook({
    rawBody: await req.text(),                       // BEFORE any json() call
    headers: Object.fromEntries(req.headers),
  });
  return new Response(null, { status: result.status });
}

// Fastify: addContentTypeParser("application/json", { parseAs: "string" }, (_r, body, done) => done(null, body))
// then pass request.body (the raw string) as rawBody.
```

The conformance suite includes a test that **fails any adapter which re-serializes a
parsed body before verifying** (same JSON value, different bytes ⇒ must reject).

**Ack fast, process async.** The handler verifies, parses, hands the event to your
`onEvent`, and expects a 2xx immediately, `onEvent` must *enqueue*, not process. Paysafe
retries effectively forever until it sees success. **Dedupe is yours:** `event.id` is a
stable key; keep the seen-set in your store. **Ordering is not guaranteed** by any PSP,
treat events as unordered facts and reconcile with `retrievePayment` when sequence matters.

**Secret rotation without cutover:** the adapters accept an *array* of signing
secrets/HMAC keys (Worldline's as `{ keyId, secretKey }` pairs matched by the webhook's
key id; PayPal verifies by postback, so there is nothing to rotate locally), register
the new one, keep the old until the PSP switches, then drop it. **Missed-webhook recovery:** `payments.fetchEvents("stripe", { since, cursor })`
replays recent events as the same normalized `UnifiedWebhookEvent`s (same ids, your
dedupe makes replays no-ops); Paysafe has no public events API (`supportsEventPolling:
false`), so its fallback stays `retrievePayment` per order. **Refund outcomes are
first-class:** async refunds that later fail arrive as `payment.refund_failed`, never as
a misleading `payment.refunded`, and `retrieveRefund(refundId)` polls any `"pending"`
refund to its terminal state. **Async rails signal progress:** SEPA/ACH-style methods
emit `payment.processing` (underway, not final) before their terminal event days later.
**Disputes resolve:** `payment.chargeback` on opening, then `payment.chargeback_won` /
`payment.chargeback_lost` when closed.

## Payment method verification vs. no-vaulting

Zero-amount verification on Stripe uses a SetupIntent, which *attaches a saved
PaymentMethod*, colliding with the no-storage constraint. PayFanout resolves this
explicitly (§8 option a): the Stripe adapter **detaches the PaymentMethod on every path**
(success, failed verification, or error, covered by tests) and surfaces a loud
`processing_error` if the detach itself fails. Prefer capability-off instead? Set
`verifyPaymentMethodStrategy: "disabled"`. Paysafe verification uses its Verifications
API with the tokenized handle, nothing stored either way.

## Conformance: how "extensible" stays true

`@payfanout/conformance` runs the identical contract against every adapter: capability
coherence, integer-minor-unit boundaries proven for JPY/BHD, raw-body webhook signatures
(incl. the re-serialization trap), stable webhook dedupe ids, error normalization with
`raw` preserved, and idempotency replay (same key twice → same result, one side effect).
Every shipped adapter passes the same suite; a future adapter is done when it does too.
See [docs/adapter-authoring.md](docs/adapter-authoring.md) for the step-by-step guide.

## Development

```bash
pnpm install
pnpm run check            # typecheck + lint + package-boundary check + all tests
pnpm run lint             # eslint (flat config, zero-warning budget in CI)
pnpm run test             # vitest only
pnpm run test:coverage    # enforces coverage thresholds (92% lines / 82% branches)
pnpm run test:integration # REAL PSP sandboxes, skipped unless credentials are set,
                          # see packages/integration-tests/test/README.md
pnpm run e2e              # Playwright browser E2E against the demo app (needs sandbox
                          # keys + `pnpm --filter @payfanout/e2e e2e:install` once)
pnpm run build            # tsc-emit every package to dist/ (d.ts + source maps);
                          # published exports point at dist via publishConfig
pnpm run release          # check + build + changeset publish
```

The test pyramid: unit + shared conformance suites against in-memory PSP fakes (fast,
always on) → env-gated integration suites against the real sandboxes (validate every
assumption the fakes encode) → Playwright E2E through the demo app (real Stripe.js /
Paysafe.js iframes, inline 3DS). CI runs the first layer on every push; the integration
layer runs via workflow dispatch with repo secrets.

The demo app (`examples/demo`) shows every shipped PSP behind identical UI, switchable at
runtime, including the tokenize-first server-completion flow behind the same `<PayButton>`:

```bash
pnpm --filter payfanout-demo dev:server   # Express API + webhook endpoints on :4242
pnpm --filter payfanout-demo dev:web      # Vite dev server (proxies /api and /webhooks)
```

Set `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `VITE_STRIPE_PUBLISHABLE_KEY` and the
other PSPs' equivalents (see `examples/demo/server.mts`) to hit real sandboxes.

### Non-goals

No built-in fraud engine beyond PSP-native signals · no marketplace/split payments
(yet, direction in docs) · **no persistence layer of any kind** (saved-card tokens and
subscription records live in YOUR database; the `SubscriptionStore` seam and the
customer/token mapping are the host's).
[docs/future-designs.md](docs/future-designs.md) holds the designs and their unblock
conditions; [docs/decisions.md](docs/decisions.md) is the running decision log,
including the 2026-07-04 decision that deliberately enabled PSP-side vaulting and
recurring payments (previously excluded by scope).

### Caveat on PSP API details

PSP endpoint paths, webhook header names, and error codes evolve; each adapter
isolates them in one place (`adapter.ts`, `webhook.ts`) with structural types and
injected transport so they can be re-verified against current docs and adjusted without
touching core, server, or app code. Re-check against your PSPs' developer portals before
going live.

## License

[MIT](LICENSE) © 2026 PayFanout contributors.

PayFanout is free and open source. Use it in commercial or private projects, fork it,
modify it, redistribute it, and send pull requests. The only condition is that the
copyright notice and the license text stay with copies of the code. Every published
`@payfanout/*` package ships the same MIT license, and contributions are accepted under
it (see [CONTRIBUTING](.github/CONTRIBUTING.md)).
