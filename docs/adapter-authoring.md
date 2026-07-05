# Writing a PayFanout adapter for a new PSP

Adding a PSP means shipping one or two new packages, **no changes to
`@payfanout/core`, `@payfanout/server`, `@payfanout/react`, or any consuming app**. You are
done when your adapter passes `@payfanout/conformance`, the same suite the Stripe and
Paysafe adapters pass. This guide assumes you have never seen the core internals; the
contracts in `@payfanout/core` plus this document are the whole interface.

## 0. Decide your PSP's completion shape first

This is the one architectural decision, everything else is mapping. Ask: *can the
browser SDK alone finalize a payment?*

| | Confirm-on-client (like Stripe) | Tokenize-first (like Paysafe) |
| --- | --- | --- |
| Server session call | creates the PSP intent object | may create nothing, see "stateless sessions" below |
| Client `confirm()` | finalizes, returns terminal status | returns `status: "requires_confirmation"` + `clientToken` |
| `completePayment` | **omit the method entirely** | **required**, finalizes with the clientToken |
| Capability flag | `requiresServerCompletion: false` | `requiresServerCompletion: true` |

`PaymentService` and `<PayButton>` already handle both shapes; you only declare which
one you are.

**Stateless sessions:** PayFanout persists nothing. If your PSP needs data at completion
time that only existed at session time (amount, currency, account id), encode it into
`pspSessionId` as a **signed** self-contained token, copy the pattern in
`packages/adapter-paysafe-server/src/session-context.ts` (HMAC prevents the browser
tampering with the amount; the client adapter reads the payload half without the key).
Embed an **expiry** in the token and enforce it on every decode, a signed token must
never stay completable forever. Prefer **WebCrypto over `node:crypto`/`Buffer`** so your
server adapter also runs on edge runtimes (the Paysafe adapter is the reference; a test
guards it against Node builtins sneaking back in).

## 1. Server adapter (`@payfanout/adapter-<psp>-server`)

Implement `ServerPaymentAdapter` from `@payfanout/core`. Rules that the conformance suite
and `PaymentService` will hold you to:

- **Config:** require explicit `environment: "sandbox" | "live"` (never inferred from
  key prefixes), explicit API version if your PSP has one, and an injectable transport
  (`client`/`fetch`) so tests run against an in-memory fake. If merchant accounts vary
  by currency/country, take a resolver function, not a single id.
- **Amounts:** integer minor units at every boundary, both directions. Use
  `getCurrencyExponent` / `assertMinorUnitAmount` from core. PSP-specific quirks (e.g.
  Stripe's three-decimal multiples-of-10) stay inside your adapter and reject with
  `invalid_request`, never leak them to callers.
- **Errors:** every rejection is a `PayFanoutError` with a taxonomy `code`, a user-safe
  `message`, an honest `retryable`, `pspName`, and the untouched PSP error on `raw`.
  Even locally-generated failures set `raw` to something diagnostic. Map at least:
  declines (+`insufficient_funds`/`expired_card`/`invalid_card_data`/
  `authentication_required`/`fraud_suspected`), 429 → `rate_limited` (retryable),
  5xx/network → `psp_unavailable` (retryable), 4xx → `invalid_request`.
- **Idempotency:** forward `idempotencyKey` on every mutating call using your PSP's
  mechanism (Stripe: `Idempotency-Key` request option; Paysafe: `merchantRefNum`). If an
  optional key is absent where your PSP requires one, derive it deterministically (e.g.
  `payfanout-void-${pspPaymentId}`), never randomly.
- **Host id round-trip:** when `input.id` is present, stamp it into PSP metadata
  (`payfanout_id`) if your PSP supports metadata, and prefer it for `PaymentInfo.id`.
- **Refund state:** never invent a "refunded" status. Report `amountRefunded`
  faithfully; callers derive state via `getRefundState`. If you declare
  `supportsRefunds`, you MUST also implement `retrieveRefund(refundId)`, async refunds
  return `"pending"` and hosts poll them to a terminal state.
- **Receipt-grade facts:** populate `PaymentInfo.paymentMethodDetails`
  (`{ brand, last4, wallet? }`, lowercase brand) once your PSP reports the instrument,
  and `mandateReference` for debit rails (SEPA/ACH/BACS), hosts must never have to dig
  into `raw` for "Visa •••• 4242".
- **Checkout fields:** map `statementDescriptor` / `receiptEmail` / `shippingDetails` /
  `sca` to whatever your PSP accepts; validate locally what you can (lengths, charsets)
  and *withhold* fields your PSP's endpoint rejects rather than failing the payment.
- **Optional surfaces, gated by capability flags** (declare `true` only if implemented,
  `PaymentService` enforces coherence at registration):
  `updatePaymentSession` ↔ `supportsSessionUpdate` (in-place amend or re-issued signed
  token, callers always continue with the returned session), `fetchEvents` ↔
  `supportsEventPolling` (missed-webhook recovery), `listPayments`/`listRefunds` ↔
  `supportsListing`, and `supportsMultiCapture` (requires `supportsManualCapture`).
- **Vaulting (`supportsSavedPaymentMethods`)** demands the full surface:
  `createCustomer`, `listSavedPaymentMethods`, `deleteSavedPaymentMethod` (keyed by the
  TOKEN, resolve PSP-internal ids inside the adapter), `chargeSavedPaymentMethod`
  (honest credential-on-file `occurrence` mapping), plus `savePaymentMethod` if you are
  tokenize-first. Cards must live at the PSP ONLY, a SavedPaymentMethod carries an
  opaque token and display facts, never chargeable card data. Save-during-checkout:
  honor session `customer` + `savePaymentMethod` and surface the stored token on
  `PaymentInfo.savedPaymentMethodToken`. The conformance suite runs a
  customer→save→list→charge×2→delete round-trip against your fake.
- **Verification without vaulting:** if zero-amount verification on your PSP creates a
  stored instrument (Stripe's SetupIntent does), you must guarantee cleanup on every
  path, success, failed verification, and error, and fail loudly if cleanup fails.
  Otherwise set `supportsPaymentMethodVerification: false`.
- **Capabilities are declarations, not decoration:** `PaymentService` rejects at
  registration if flags contradict your implemented surface (e.g.
  `requiresServerCompletion` without `completePayment`, or `supportsSavedPaymentMethods`
  without the full vault surface below). Vaulting is **in scope** as of the 2026-07-04
  decision, every shipped adapter sets `supportsSavedPaymentMethods: true`; declare it
  `true` only if you implement the whole surface, otherwise declare it `false` honestly.

### Webhooks

- `verifyWebhookSignature(rawBody, headers)` must hash the **exact raw body string**.
  Never `JSON.parse` + re-serialize before hashing, the conformance suite feeds you a
  re-serialized body (same JSON value, different bytes) and requires `false`. Use
  constant-time comparison (`crypto.timingSafeEqual`) and enforce a timestamp tolerance
  if your PSP includes one (replay protection). Headers arrive lowercased by
  `@payfanout/server`, but lowercase them yourself too, adapters are callable directly.
- Accept an **array** of signing secrets/HMAC keys so rotation needs no cutover, any
  active key verifying wins.
- `parseWebhookEvent` returns a `UnifiedWebhookEvent` with a **stable `id`** (the PSP's
  event id; if absent, hash the raw bytes). Map known event types onto the unified
  vocabulary; unknown-but-valid types become `type: "unknown"`, only unparseable
  payloads throw (`invalid_request`). Timestamps come from the payload, never from
  `Date.now()`.
- **Map outcomes honestly:** a refund-object event maps by the refund's own status
  (`failed` → `payment.refund_failed`, never a misleading `payment.refunded`); async
  rails emit `payment.processing` before their terminal event; disputes resolve into
  `payment.chargeback_won` / `payment.chargeback_lost`.

## 2. Client adapter (`@payfanout/adapter-<psp>`)

Implement `ClientPaymentAdapter`:

- **Boundary:** this package ships to browsers. It may depend on `@payfanout/core` only,
  `scripts/check-boundaries.mjs` fails the build if it references the server adapter,
  a Node SDK, or anything holding secrets. Type your PSP's browser SDK structurally and
  take `loadScript`/`get<Psp>Global` test seams in config.
- `loadSdk()`: inject the PSP script lazily and idempotently; guard SSR (`typeof window`)
  with a clear `invalid_request` error. `<PayFanoutProvider>` never calls you eagerly.
- `mount(container, options)`: render **hosted/iframe fields only** (SAQ-A), never a raw
  card input. Forward `options.appearance` to the PSP's styling hooks. Return a branded
  handle via `brandMountedFieldsHandle`, and validate handles you receive back.
- **Customization is a passthrough, not an enumeration:** forward
  `options.fieldOptions` to your SDK's field-creation call untouched (host wins), and
  `options.locale` to its locale option, protect ONLY the keys your adapter must own
  to function (mount selectors, environment, session-derived currency/account), and
  document them. Split-field PSPs must honor the slot convention: elements inside the
  container with `data-payfanout-field="<name>"` are the host's mount points (never
  remove them on unmount); fall back to your own stacked containers without slots.
- `confirm(handle)`: resolve 3DS/next-action **inline** (iframe/modal, e.g. Stripe's
  `redirect: "if_required"`); a full-page navigation is a contract violation for
  card flows. Return your completion shape from §0. Failures resolve (not reject) with
  `{ status: "failed", error }`, `raw` preserved.
- **Field-state events:** fire `options.onChange({ complete: false })` once on mount,
  then on every SDK validity change, this drives "disable Pay until complete" UX.
  Registration must be defensive: an SDK build without the event surface degrades
  (onChange stays initialized), it never breaks `mount`.
- `handleRedirectReturn(location)` (optional): for `flow: "redirect"` methods, inspect
  the landing URL and resolve the outcome from the PSP object itself, not from a
  status hint in the query string. Return `null` when the URL carries no params for
  your PSP, `useRedirectReturn` probes every registered adapter.
- `listPaymentMethodCapabilities()`: be honest about flows, a bank redirect is
  `flow: "redirect"`, a cash voucher is `voucher_code`. If enablement varies per merchant
  account, default conservatively and accept a config override.

## 3. Wire up the conformance suite

```ts
// packages/adapter-acme-server/test/acme-server.test.ts
import { runServerAdapterConformanceTests } from "@payfanout/conformance";
import { AcmeServerAdapter } from "../src/index.js";
import { FakeAcmeApi } from "./fake-acme-api.js";   // in-memory API that dedupes like the real one

let lastFake: FakeAcmeApi;
runServerAdapterConformanceTests("acme", () => { /* fresh adapter + fake */ }, {
  createSessionInput: () => ({ amount: 1099, currency: "USD", idempotencyKey: `k-${Math.random()}` }),
  zeroDecimalSessionInput: () => ({ amount: 500, currency: "JPY", idempotencyKey: `k-${Math.random()}` }),
  threeDecimalSessionInput: () => ({ amount: 1234, currency: "BHD", idempotencyKey: `k-${Math.random()}` }),
  webhook: { validRawBody, validHeaders, expectedType: "payment.succeeded", expectedEventId: "evt_1" },
  failingCalls: [ /* missing ids, declines, tampered tokens … with expected taxonomy codes */ ],
  idempotency: {
    run: async (adapter, key) => [/* same mutating call twice with `key` */],
    sideEffectCount: () => lastFake.uniqueCreations,   // must be exactly 1
  },
  completePayment: { input: (session) => ({ /* only for tokenize-first PSPs */ }) },
});
```

Add `runClientAdapterConformanceTests` for the client package the same way. Build your
fake against the PSP's documented behavior (including idempotency dedupe and error
bodies) so the suite proves plumbing, then validate against the PSP sandbox manually
before going live.

## 4. Checklist before you call it done

- [ ] `pnpm run check` green (typecheck + boundary check + all tests)
- [ ] Server + client conformance suites pass
- [ ] Both webhook ingress patterns work with your adapter (per-adapter and unified)
- [ ] Full + partial refund, cancel-before-capture, manual capture (if supported) exercised against the PSP sandbox
- [ ] JPY and BHD amounts round-trip correctly end-to-end
- [ ] Registered in the demo app (`examples/demo`) and payable behind the unchanged `<PayButton>`, if the demo needed edits beyond adding your adapter to the two registries, something leaked
