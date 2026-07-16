# Writing a PayFanout adapter for a new PSP

Adding a PSP means shipping one or two new packages, **no changes to
`@payfanout/core`, `@payfanout/server`, `@payfanout/react`, or any consuming app**. You are
done when your adapter passes `@payfanout/conformance`, the same suite the Stripe,
Paysafe, GoCardless, PayPal, and PayZen adapters pass. This guide assumes you have never
seen the core internals; the contracts in `@payfanout/core` plus this document are the
whole interface.

## 0. Decide your PSP's completion shape first

This is the one architectural decision, everything else is mapping. Ask: *how does a
payment reach its terminal state?* The shipped adapters cover three shapes:

| | Confirm-on-client (Stripe, PayZen) | Tokenize-first (Paysafe, PayPal, Worldline) | Redirect / hosted (GoCardless) |
| --- | --- | --- | --- |
| Server session call | creates the PSP intent object | may create nothing, see "stateless sessions" | creates the PSP object + hosted URL |
| Client `confirm()` | finalizes, returns terminal status | returns `requires_confirmation` + `clientToken` | navigates to the hosted flow |
| `completePayment` | **omit the method entirely** | **required**, finalizes with the clientToken | omit (the PSP fulfils on its side) |
| Capability flag | `requiresServerCompletion: false` | `requiresServerCompletion: true` | `false`, every method `flow: "redirect"` |

PayPal is tokenize-first with a **popup** approval instead of hosted fields (the
clientToken is the approved order id); GoCardless proves a PSP with **no embeddable
fields at all** still fits — the client adapter's `confirm()` hands off to the hosted
authorisation page and `handleRedirectReturn` finishes the trip. Declare what you are;
`PaymentService` and `<PayButton>` already handle every shape.

**Stateless sessions:** PayFanout persists nothing. If your PSP needs data at completion
time that only existed at session time (amount, currency, account id), encode it into
`pspSessionId` as a **signed** self-contained token — the pattern lives in
`packages/adapter-paysafe-server/src/session-context.ts` (HMAC prevents the browser
tampering with the amount; the client adapter reads the payload half without the key).
Embed an **expiry** and enforce it on every decode: expired tokens reject with
`code: "session_expired"` (hosts recover by creating a fresh session), a signed token
must never stay completable forever. Build on core's WebCrypto helpers
(`hmacSha256`, `constantTimeEqual`, the base64url family) instead of `node:crypto`/
`Buffer` so your server adapter also runs on edge runtimes — every REST adapter has a
test guarding against Node builtins sneaking back in (the Stripe adapter is the one
Node-only exception, its SDK requires Node).

## 1. Server adapter (`@payfanout/adapter-<psp>-server`)

Implement `ServerPaymentAdapter` from `@payfanout/core`. Rules that the conformance suite
and `PaymentService` will hold you to:

- **Config:** require explicit `environment: "sandbox" | "live"` (never inferred from
  key prefixes), explicit API version if your PSP has one, and an injectable transport
  (`client`/`fetch`) so tests run against an in-memory fake. If merchant accounts vary
  by currency/country, take a resolver function, not a single id.
- **Transport:** compose core's transport primitives — `requestWithTimeout` (the timer
  covers the whole exchange INCLUDING the response body read; a stalled body must time
  out, not hang the host), `withTransportRetries` (never retry business rejections),
  `isTransportRetryable`, `safeJson`. Expose `requestTimeoutMs`, `maxNetworkRetries`,
  and a `sleep` test seam like every shipped REST adapter.
- **Amounts:** integer minor units at every boundary, both directions. Use
  `getCurrencyExponent` / `assertMinorUnitAmount` from core. PSP-specific quirks (e.g.
  Stripe's three-decimal multiples-of-10) stay inside your adapter and reject with
  `invalid_request`, never leak them to callers.
- **Hard currency constraints** go in `capabilities.supportedCurrencies` (uppercase
  ISO 4217; omit when unrestricted). The router pre-screens candidates with it — a
  declared constraint means a mismatched payment skips your PSP instead of aborting the
  failover cascade on your local rejection. Keep the local validation as defense.
- **Per-rail currency constraints** go in the same shape one level down, on the method:
  `paymentMethods: [{ type: "sepa_debit", flow: "embedded", supported: true, currencies: ["EUR"] }]`.
  Absent or empty means unrestricted, exactly as `supportedCurrencies` reads, and the
  PSP-wide list still applies on top. Declare it for any rail that settles in fixed
  currencies (SEPA/EUR, Bacs/GBP, PAD/CAD) — a guard you keep private instead makes a
  CAD-only rail look available for a USD payment, so the router cannot fail over to a
  PSP that could have served it. Same rule as above: declare it *and* keep the local
  check, since a host can drive the adapter without the router and can override
  `paymentMethods` wholesale. Derive both from one constant so they cannot drift. A rail
  gated to currencies your `supportedCurrencies` excludes is unroutable and
  `validateAdapterCapabilities` rejects it.
- **Per-rail country constraints** are the customer-side sibling:
  `countries: ["GB"]` (uppercase ISO 3166-1 alpha-2) on a rail only customers in those
  countries can pay with — Bacs needs a UK bank account, Interac a Canadian one.
  Screening consults it only when the session states `customerCountry`; absent input
  screens nothing, so declaring it never hides your PSP from a host that doesn't know
  the customer's country. Declare only what the provider documents as a country or a
  short closed list; a zone rail (SEPA) stays undeclared — zone membership drifts, and
  a stale list would screen out valid payments.
- **Errors:** every rejection is a `PayFanoutError` with a taxonomy `code`, a user-safe
  `message` (use core's `getUserMessage(code)` catalog — never a third English variant),
  an honest `retryable`, `pspName`, and the untouched PSP error on `raw`. Even
  locally-generated failures set `raw` to something diagnostic. Map at least: declines
  (+`insufficient_funds`/`expired_card`/`invalid_card_data`/`authentication_required`/
  `fraud_suspected`), 429 → `rate_limited`, 5xx/network → `psp_unavailable`, 4xx →
  `invalid_request` (core's `classifyHttpFallback` is that tail). Retryable semantics
  are contract, not taste: `rate_limited`/`psp_unavailable` are always retryable,
  `authentication_required` NEVER is (the customer comes back on-session) — the
  conformance suite asserts both.
- **Idempotency:** `idempotencyKey` is REQUIRED on every mutating call — session
  creation, completion, refunds, **capture, cancel, and verification included**.
  Forward it through your PSP's mechanism (Stripe: `Idempotency-Key` request option;
  Paysafe: `merchantRefNum`; GoCardless: `Idempotency-Key` header; PayPal:
  `PayPal-Request-Id`). If your PSP has no idempotency channel (PayZen), document how
  its state machine makes replays safe instead.
- **Host id round-trip:** when `input.id` is present, stamp it into PSP metadata
  (`payfanout_id`) if your PSP supports metadata, and prefer it for `PaymentInfo.id`.
  Echo the stored metadata on `PaymentInfo.metadata`. If your PSP genuinely cannot
  (Paysafe strict-rejects extra fields; the id rides the signed token only), declare it
  honestly in the conformance fixtures via `money.expectations` — never fake it.
- **Money truth on `PaymentInfo`:** report `amountRefunded` faithfully (callers derive
  refund state via `getRefundState` — never invent a "refunded" status), and populate
  `amountCaptured`/`amountCapturable` wherever your PSP reports settlement state —
  partial and multi-capture flows are invisible without them. If you declare
  `supportsRefunds`, you MUST implement `retrieveRefund(refundId)`; async refunds
  return `"pending"` and hosts poll them to a terminal state.
- **Receipt-grade facts:** populate `PaymentInfo.paymentMethodDetails`
  (`{ brand, last4, wallet?, expMonth?, expYear? }`, lowercase brand) once your PSP
  reports the instrument, and `mandateReference` for debit rails (SEPA/ACH/BACS), hosts
  must never have to dig into `raw` for "Visa •••• 4242".
- **Checkout fields:** map `statementDescriptor` / `receiptEmail` / `shippingDetails` /
  `sca` to whatever your PSP accepts; validate locally what you can (lengths, charsets)
  and *withhold* fields your PSP's endpoint rejects rather than failing the payment.
- **Optional surfaces, gated by capability flags** (declare `true` only if implemented,
  `PaymentService` enforces coherence at registration via core's
  `validateAdapterCapabilities`): `updatePaymentSession` ↔ `supportsSessionUpdate`
  (in-place amend or re-issued signed token, callers always continue with the returned
  session), `fetchEvents` ↔ `supportsEventPolling` (missed-webhook recovery),
  `listPayments`/`listRefunds` ↔ `supportsListing`, and `supportsMultiCapture`
  (requires `supportsManualCapture`; every partial capture is its own charge with its
  own idempotency key).
- **Vaulting (`supportsSavedPaymentMethods`) is optional and must be honest.** Card
  rails that can vault should (Stripe, Paysafe, PayZen candidates); rails that cannot
  meet the contract's instantly-succeeded off-session charge declare `false` — as
  GoCardless (async bank debits) and PayPal (v3 vault is future work) do today.
  Declaring it demands the full surface: `createCustomer`, `listSavedPaymentMethods`,
  `deleteSavedPaymentMethod` (keyed by the TOKEN, resolve PSP-internal ids inside the
  adapter), `chargeSavedPaymentMethod` (honest credential-on-file `occurrence`
  mapping), plus `savePaymentMethod` if you are tokenize-first. Cards live at the PSP
  ONLY. Save-during-checkout: honor session `customer` + `savePaymentMethod` and
  surface the stored token on `PaymentInfo.savedPaymentMethodToken`. The conformance
  suite runs a customer→save→list→charge×2→delete round-trip against your fake.
- **Verification without vaulting:** if zero-amount verification on your PSP creates a
  stored instrument (Stripe's SetupIntent does), you must guarantee cleanup on every
  path, success, failed verification, and error, and fail loudly if cleanup fails.
  Otherwise set `supportsPaymentMethodVerification: false`.

### Webhooks

- `verifyWebhookSignature(rawBody, headers)` must operate on the **exact raw body
  string**. Never `JSON.parse` + re-serialize before verifying, the conformance suite
  feeds you a re-serialized body (same JSON value, different bytes) and requires
  `false`. Three verification patterns are shipped precedent: local HMAC over the raw
  bytes with constant-time comparison and timestamp tolerance (Stripe, Paysafe,
  GoCardless, PayZen — use core's `constantTimeEqual`), and **postback verification**
  where the PSP's API confirms the signature (PayPal — splice the raw body into the
  postback by string concatenation, fail closed on any transport trouble).
- Accept an **array** of signing secrets/HMAC keys so rotation needs no cutover, any
  active key verifying wins (core's `normalizeSecrets`).
- `parseWebhookEvent` returns a `UnifiedWebhookEvent` with a **stable `id`** (the PSP's
  event id; if absent, hash the raw bytes). Map known event types onto the unified
  vocabulary; unknown-but-valid types become `type: "unknown"` (conformance proves this
  on a correctly signed body), only unparseable payloads throw (`invalid_request`).
  Timestamps come from the payload, never from `Date.now()`.
- **Batched deliveries:** the unified contract is one event per delivery. If your PSP
  batches (GoCardless ships up to 250 events under one signature), make
  `parseWebhookEvent` THROW on batched payloads and export a PSP-specific fan-out
  helper (`parseGoCardlessWebhookEvents` is the pattern: verify once, fan out per
  event) — never silently drop trailing events.
- **Money facts ride the event** where the payload carries them: populate
  `amount`/`currency` (integer minor units) and `refundId` on refund-shaped events so
  hosts don't need a retrieve round-trip. Never fabricate them from other fields.
- **Map outcomes honestly:** a refund-object event maps by the refund's own status
  (`failed` → `payment.refund_failed`, never a misleading `payment.refunded`); async
  rails emit `payment.processing` before their terminal event; disputes resolve into
  `payment.chargeback_won` / `payment.chargeback_lost`.

### Onboarding descriptor & `verifyCredentials`

Export a declarative `AdapterOnboardingDescriptor` (from `@payfanout/core`) so a host can
build its provider-settings screen — credential fields, "events to subscribe", CSP hosts —
as generic loops instead of per-PSP forms. Ship it from the **server** package (it carries
the webhook event list and pairs with the server-only probe below), even though it also
describes the client credential fields:

```ts
// packages/adapter-acme-server/src/onboarding.ts
import type { AdapterOnboardingDescriptor } from "@payfanout/core";
export const acmeOnboarding: AdapterOnboardingDescriptor = {
  pspName: "acme",
  credentialFields: [
    { key: "secretKey", kind: "secret", scope: "server", format: { pattern: "^sk_", hint: "Acme secret key" } },
    { key: "publishableKey", kind: "public", scope: "client", format: { pattern: "^pk_" } },
    { key: "webhookSecret", kind: "secret", scope: "server" },
  ],
  // `events` = the exact provider strings your parser recognizes; OMIT it if the PSP has
  // no discrete subscribable event types (PayZen sends order-state snapshots).
  webhook: { signature: "hmac-sha256-hex", events: ["payment.succeeded", "payment.failed"] },
  csp: { script: ["https://sdk.acme.test"], frame: [], connect: ["https://api.acme.test"] },
};
```

Pass it as `onboarding` in the conformance fixtures and the suite asserts it via
`validateOnboardingDescriptor`: `pspName` matches the adapter, credential fields are
well-formed and unique with at least one `scope: "server"` field, each `format.pattern`
compiles, and `webhook.events`/CSP hosts carry no blanks. Keep it honest and co-located with
the config and webhook parser so it can't drift — `secret` fields are never redisplayed by a
host, `perCurrency` marks per-currency accounts (Paysafe merchant accounts), and the
`signature` is `hmac-sha256-hex` (Stripe/PayZen/GoCardless), `hmac-sha256-base64` (Paysafe),
or `provider-postback` (PayPal).

Optionally implement **`verifyCredentials()`** — a side-effect-free probe behind a host
"Test connection" button. Make ONE read-only call (a vault/list read, an OAuth mint, a
liveness endpoint) and classify: `{ ok: true }`, or `{ ok: false, category }` with `auth`
(401/403 — wrong key), `network` (timeout/5xx/429 — transient), or `internal`. Never mutate
PSP state, never retry an auth rejection, never log secrets.

## 2. Client adapter (`@payfanout/adapter-<psp>`)

Implement `ClientPaymentAdapter`:

- **Boundary:** this package ships to browsers. It may depend on `@payfanout/core` only,
  `scripts/check-boundaries.mjs` fails the build if it references the server adapter,
  a Node SDK, or anything holding secrets — and fails if the package is missing from
  its allowlist entirely. Type your PSP's browser SDK structurally and take
  `loadScript`/`get<Psp>Global` test seams in config.
- `loadSdk()`: inject the PSP script lazily and idempotently (core's `injectScript` /
  `assertBrowser` helpers); guard SSR with a clear error. `<PayFanoutProvider>` never
  calls you eagerly.
- `mount(container, options)`: render **hosted/iframe fields only** (SAQ-A), never a raw
  card input. Forward `options.appearance` to the PSP's styling hooks. Return a branded
  handle via `brandMountedFieldsHandle`, and validate handles you receive back. A
  redirect-only PSP (GoCardless) may mount a lightweight explainer instead of fields.
- **Customization is a passthrough, not an enumeration:** forward
  `options.fieldOptions` to your SDK's field-creation call untouched (host wins), and
  `options.locale` to its locale option, protect ONLY the keys your adapter must own
  to function (mount selectors, environment, session-derived currency/account), and
  document them. Split-field PSPs must honor the slot convention: elements inside the
  container carrying core's `DATA_PAYFANOUT_FIELD` attribute are the host's mount
  points (never remove them on unmount); fall back to your own stacked containers
  without slots.
- `confirm(handle)`: resolve 3DS/next-action **inline** (iframe/modal, e.g. Stripe's
  `redirect: "if_required"`); a full-page navigation is a contract violation for
  card flows — but IS the flow for redirect-shaped PSPs, where `confirm()` navigates
  to the hosted page. Return your completion shape from §0. Failures resolve (not
  reject) with `{ status: "failed", error }`, `raw` preserved.
- **Field-state events:** fire `options.onChange({ complete: false })` once on mount,
  then on every SDK validity change, this drives "disable Pay until complete" UX.
  Registration must be defensive: an SDK build without the event surface degrades
  (onChange stays initialized), it never breaks `mount`.
- `handleRedirectReturn(location)`: **required whenever you report a supported
  `flow: "redirect"` method** (the client conformance suite enforces it — a redirect
  flow without a return-trip handler strands the customer). Inspect the landing URL
  and resolve the outcome from the PSP object itself, not from a status hint in the
  query string. Return `null` when the URL carries no params for your PSP,
  `useRedirectReturn` probes every registered adapter.
- `listPaymentMethodCapabilities()`: be honest about flows, a bank redirect is
  `flow: "redirect"`, a cash voucher is `voucher_code`. If enablement varies per
  merchant account, default conservatively and accept a config override.

## 3. Wire up the conformance suite

```ts
// packages/adapter-acme-server/test/acme-server.test.ts
import { runServerAdapterConformanceTests } from "@payfanout/conformance";
import { AcmeServerAdapter } from "../src/index.js";
import { FakeAcmeApi } from "./fake-acme-api.js";   // in-memory API that dedupes like the real one

runServerAdapterConformanceTests("acme", () => { /* fresh adapter + fake */ }, {
  createSessionInput: () => ({ amount: 1099, currency: "USD", idempotencyKey: `k-${Math.random()}` }),
  zeroDecimalSessionInput: () => ({ amount: 500, currency: "JPY", idempotencyKey: `k-${Math.random()}` }),
  threeDecimalSessionInput: () => ({ amount: 1234, currency: "BHD", idempotencyKey: `k-${Math.random()}` }),
  webhook: {
    validRawBody, validHeaders,
    expectedType: "payment.succeeded", expectedEventId: "evt_1",
    expectedAmount: 1099,                      // when the payload carries an amount
    unknownEvent: { rawBody, headers },        // SIGNED body of a type you don't map
  },
  // The money paths are proven, not trusted:
  money: {
    completedPayment: async (adapter, { amount, id, metadata }) => { /* drive the fake to a completed payment, return pspPaymentId */ },
    authorizedPayment: async (adapter, { amount }) => { /* manual-capture PSPs: authorized, uncaptured */ },
    cancelablePayment: async (adapter) => { /* a pre-completion payment; cancel must yield "canceled" */ },
    // Declare documented PSP limitations honestly (defaults are true):
    // expectations: { idRoundTrip: false, metadataEcho: false },
  },
  failingCalls: [ /* missing ids, declines, expired tokens … with expected taxonomy codes */ ],
  idempotency: {
    run: async (adapter, key) => [/* same mutating call twice with `key` */],
    sideEffectCount: () => lastFake.uniqueCreations,   // must be exactly 1
  },
  completePayment: { input: (session) => ({ /* only for tokenize-first PSPs */ }) },
});
```

Add `runClientAdapterConformanceTests` for the client package the same way. Build your
fake against the PSP's documented behavior (including idempotency dedupe, over-refund
rejection, and capture-state bookkeeping — the money cases exercise all of it) so the
suite proves plumbing, then validate against the PSP sandbox manually before going live.

## 4. Checklist before you call it done

- [ ] `pnpm run check` green (typecheck + boundary check + all tests)
- [ ] Server + client conformance suites pass — including every money-path case
- [ ] Both webhook ingress patterns work with your adapter (per-adapter and unified)
- [ ] Exports an `AdapterOnboardingDescriptor` wired into the conformance `onboarding`
      fixture; `verifyCredentials()` implemented if the PSP has a safe read-only probe
- [ ] Full + partial refund, over-refund rejection, cancel-before-capture, manual
      capture / multi-capture (if supported) exercised against the PSP sandbox
- [ ] JPY and BHD amounts round-trip correctly end-to-end (or the constraint is
      declared via `supportedCurrencies`)
- [ ] Registered in the demo app (`examples/demo`) and payable behind the unchanged
      `<PayButton>`, if the demo needed edits beyond adding your adapter to the two
      registries, something leaked
- [ ] Added to `scripts/check-boundaries.mjs` (the check fails unclassified packages),
      the README packages table, `typedoc.json`, and the integration workflow's env
