# @payfanout/adapter-paysafe-server

## 1.4.0

### Minor Changes

- eed2987: Add PSP-native subscription support over the Paysafe Payment Scheduler (`subscriptionsplans/v1`), authenticated with the same API key as the Payments API: `listNativeSubscriptions` (offset paging surfaced as an opaque cursor), `retrieveNativeSubscription`, `createNativeSubscription`, and `cancelNativeSubscription`. Creation charges a multi-use payment handle token under `POST /plans/{planId}/subscriptions` — a given `planId` is fetched and validated against the input before anything is created, and without one the adapter mints an open-ended plan inline; `merchantRefNum` doubles as the idempotency channel, with replayed creates recovered by reference lookup. Cancellation PATCHes the final `CANCELLED` status and is verified-idempotent (a rejected cancel re-fetches and treats `CANCELLED`/`COMPLETED` as success). Day, month, and year cadences only — weekly intervals and RRULE schedules reject as `invalid_request`.

### Patch Changes

- Updated dependencies [eed2987]
  - @payfanout/core@3.0.0

## 1.3.0

### Minor Changes

- b23ca0e: Support Interac e-Transfer on Paysafe (Canada, CAD). Paysafe.js cannot tokenize this rail, so `createPaymentSession` mints the payment handle server-side and the customer authenticates at their bank; the return trip resolves through `handleRedirectReturn` and the existing server-completion route, with the terminal outcome arriving by webhook. Request a session with `paymentMethodTypes: ["interac_etransfer"]`, a `returnUrl`, and the customer's email.
- 9fa81c4: Support Paysafe's direct-debit rails: SEPA (`sepa_debit`, EUR), ACH (`ach`), BACS (`bacs_debit`, GBP/UK), and EFT (`pad`, Canada). These are Payments-API rails Paysafe.js cannot tokenize, so the client adapter renders its own bank-details fields (account holder + IBAN, routing + account, sort code + account, or institution + transit + account), with a mandate-consent checkbox on SEPA and BACS, and the details travel to the server through the existing completion route. The server adapter mints the payment handle and charges it with `settleWithAuth: true` in one completion step, surfaces the SEPA/BACS mandate reference on `PaymentInfo.mandateReference`, and maps Paysafe's returned-payment webhook (both documented spellings) to `payment.failed` so late bank returns finalize the payment. All four rails are off by default — enablement is per-account; opt in via `config.paymentMethods`, keeping each rail's declared currency and country gates, and restrict each session to exactly one bank rail.

### Patch Changes

- 80b9bb6: Country-bound rails now declare the customer countries they serve, so a session that states `customerCountry` routes past them when the customer cannot pay with them: iDEAL (NL), ACH (US) and Bacs (GB) on Stripe; Bacs (GB) on GoCardless; Interac e-Transfer (CA) on Paysafe. SEPA stays country-unrestricted on every adapter — the providers document a zone, not a country. As with the currency gates, a `config.paymentMethods` override replaces the declared defaults wholesale, so an override must carry its own `countries` for the router to pre-screen by them.
- d1d42fa: Bank rails now declare the currency they settle in, so the router skips them for a payment they could never have completed: iDEAL and SEPA in EUR, ACH in USD, Bacs in GBP on Stripe; SEPA in EUR and Bacs in GBP on GoCardless. Previously a EUR-only rail looked available for a GBP payment and failed at the PSP.

  Paysafe's Interac e-Transfer declares CAD as well, but the rail stays off by default, and `config.paymentMethods` replaces the declared defaults wholesale — so an account that opts the rail in must carry `currencies: ["CAD"]` in its own override for the router to pre-screen it. The adapter's CAD check is unchanged either way.

- Updated dependencies [80b9bb6]
- Updated dependencies [d1d42fa]
  - @payfanout/core@2.0.0

## 1.2.1

### Patch Changes

- 07c97b4: Read the Paysafe webhook event name from `eventName`, the field real Payments-API deliveries use. Previously only `eventType`/`event` were consulted, so genuine deliveries mapped to the `unknown` event type and were acknowledged without effect; `PAYMENT_COMPLETED` and the other documented events now map to their unified types. The top-level `type` field (the resource category) is deliberately ignored.

## 1.2.0

### Minor Changes

- 3be57b0: Add a declarative adapter onboarding descriptor and an optional credential probe.
  `@payfanout/core` exports `AdapterOnboardingDescriptor` — credential-field metadata (kind,
  scope, format hints, per-currency), the webhook signature scheme and event list, and CSP
  hosts — plus `validateOnboardingDescriptor`, and `ServerPaymentAdapter` gains an optional
  `verifyCredentials()` that reports whether the configured credentials authenticate (auth vs
  network vs internal). Every server adapter (Stripe, Paysafe, PayPal, PayZen, GoCardless) now
  exports a descriptor and implements `verifyCredentials`, and the conformance suite validates
  each descriptor against its adapter. Hosts can render provider-settings forms, validate
  credential shapes, drive webhook-subscription copy, build CSP headers, and offer a "Test
  connection" button as generic loops over the descriptor — identical for every adapter.

### Patch Changes

- Updated dependencies [3be57b0]
  - @payfanout/core@1.2.0

## 1.1.0

### Minor Changes

- 66095d1: Accept `billingDetails` on `CompletePaymentInput`. Hosts can now attach AVS billing — typically a postal code collected on the payment step — at completion instead of only at session creation. The Paysafe server adapter merges it over the session's billing before charging, so AVS-enforcing accounts complete without recreating the session (previously they failed with error 3004). Confirm-on-client adapters (Stripe) never call `completePayment` and are unaffected.

### Patch Changes

- Updated dependencies [66095d1]
  - @payfanout/core@1.1.0

## 1.0.2

### Patch Changes

- b190438: Remove the stale "not yet published to npm" notice from the package README. The package has been available on the public npm registry since its first release.
- Updated dependencies [b190438]
  - @payfanout/core@1.0.2

## 1.0.1

### Patch Changes

- cbb52de: Remove the stale "not yet published to npm" notice from the package README. The package has been available on the public npm registry since its first release.
- Updated dependencies [cbb52de]
  - @payfanout/core@1.0.1

## 1.0.0

### Major Changes

- d68ccbb: Harden the adapter contract. Breaking: `capturePayment`, `cancelPayment`, and `verifyPaymentMethod` now REQUIRE an idempotency key (capture is the canonical double-charge operation; under multi-capture every partial capture carries its own key); `RefundRequest.reason` is typed to `"duplicate" | "fraudulent" | "requested_by_customer"`; capability guards reject with the new `unsupported_operation` code (previously `invalid_request`), expired stateless session tokens with the new `session_expired`; `authentication_required` is never retryable on any adapter; `withRetry`'s `maxDelayMs` is now a hard ceiling with jitter included.

  Additions: `AdapterCapabilities.supportedCurrencies` declares hard PSP currency constraints and the router/service pre-screen them (a PayPal-unsupported currency now skips to the next PSP instead of aborting the cascade); `PaymentInfo` reports `amountCaptured`, `amountCapturable`, and echoes `metadata` where the PSP supports it; `PaymentMethodDetails` carries `expMonth`/`expYear`; webhook events carry normalized `amount`, `currency`, and `refundId` where the payload does; `RetryPolicy.signal` cancels between attempts; new helpers `allocate` (lost-cent-free integer splits), `REFUND_STATUSES`/`RefundStatus`, `isUnifiedWebhookEventType`, `isUnifiedPaymentMethodType`, and the `DATA_PAYFANOUT_FIELD` slot constant.

  The conformance suite now proves the money paths on every adapter — retrieve truth, full/partial/over-refund behavior, pending-refund polling, capture and multi-capture amounts, clean cancellation, unknown-webhook mapping, per-code retryable semantics, and redirect-flow client adapters must implement `handleRedirectReturn`.

### Patch Changes

- 8b720a8: Per-adapter consistency: the Stripe server config gains a `paymentMethods` override (dashboard enablement varies per account — stop hardcoding iDEAL/SEPA/ACH/BACS as supported) and `requestTimeoutMs` (threaded to the SDK's timeout, default remains the SDK's 80s); `listSavedPaymentMethods` pages past 100 stored methods instead of silently truncating. Paysafe error 3004 (billing zip required) now maps to `invalid_request` instead of masquerading as a card decline. All REST adapters validate `maxNetworkRetries` as an integer ≥ 0 at construction, Stripe validates `webhookToleranceSeconds`, and GoCardless clamps list page sizes to its documented 1–500 bounds.
- 0e31e62: The request timeout now covers the response body read. A PSP response that stalled after its headers arrived could previously hang the host's request handler indefinitely; it now rejects with the same retryable `psp_unavailable` timeout error as a connection hang.
- a016891: Adapter plumbing that existed as four-to-five drifting copies now lives once in `@payfanout/core`, and every adapter consumes it: the WebCrypto/base64 helper family (`hmacSha256`, `constantTimeEqual`, …, with the node:crypto bit-equivalence tests moved alongside), the REST transport primitives (`requestWithTimeout` with the timer covering the body read, `withTransportRetries`, `isTransportRetryable`, `safeJson`), the HTTP error tail (`classifyHttpFallback`), capability coherence (`validateAdapterCapabilities`, shared by `PaymentService` and the conformance suite), client SDK loading (`assertBrowser`, `injectScript`), and webhook utilities (`normalizeTime`, `lowercaseKeys`, `normalizeSecrets`). Behavior is unchanged apart from a few user-message strings converging on core's catalog text; all transport timing, retry, and edge-runtime guarantees are preserved and still guard-tested. Core remains zero-dependency and browser-safe.
- Updated dependencies [d68ccbb]
- Updated dependencies [d2c4702]
- Updated dependencies [43569f4]
- Updated dependencies [a016891]
  - @payfanout/core@1.0.0

## 0.1.1

### Patch Changes

- Updated dependencies [6e039c2]
  - @payfanout/core@0.2.0
