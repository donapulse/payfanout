# @payfanout/adapter-payzen-server

## 1.3.0

### Minor Changes

- eed2987: Add PSP-native subscription support over the PayZen REST V4 recurrence operations: `retrieveNativeSubscription`, `createNativeSubscription` (`Charge/CreateSubscription`), and `cancelNativeSubscription` (`Subscription/Cancel`). PayZen has no list operation, so `nativeSubscriptions.list` stays false — retain both `subscriptionId` and `paymentMethodToken`, which PayZen requires together on retrieve and cancel. Simple intervals synthesize an `RRULE:FREQ=…;INTERVAL=…` value and RFC 5545 schedules pass through (sub-daily frequencies reject); the subscription's status is derived from `cancelDate`, installment counters, and `effectDate`, since the V4 object carries no status field. Creation applies immediately and PayZen offers no idempotency channel — the adapter never auto-retries it, stamps a deterministic order id for traceability, and documents the at-most-once expectation; cancellation is verified-idempotent by re-fetch across both PayZen rejection channels.

### Patch Changes

- Updated dependencies [eed2987]
  - @payfanout/core@3.0.0

## 1.2.0

### Minor Changes

- 2530a08: Add PayZen's bank rails through the hosted payment page: SEPA Direct Debit (`sepa_debit`), iDEAL (`ideal`), the pay-by-bank family — SEPA Credit Transfer via payment initiation, MyBank, Przelewy24 (`bank_redirect_generic`) — and Multibanco (`voucher_generic`). Sessions requesting a bank rail create a payment order and return the hosted page URL as `clientSecret` (`status: "requires_action"`, `returnUrl` required); the client adapter renders an informational panel, `confirm()` redirects, and the new `handleRedirectReturn` resolves the return trip while the IPN stays the source of truth. Each rail is a per-shop contract and defaults to `supported: false` in the `paymentMethods` capability declaration.
- cd165ee: Add payment-method selection on PayZen. Sessions can restrict the offered methods with `paymentMethodTypes` (mapped onto Charge/CreatePayment's `paymentMethods` field: card, Apple Pay, PayPal — wallet enablement is a per-shop contract declared via the new `paymentMethods` config override on both adapters), and the client adapter renders the multi-method smartForm with `form: "smartform"` or `"smartform-expanded"`, where the form owns its pay buttons and `confirm()` awaits the buyer's in-form completion. The new `fetchAvailablePaymentMethods()` returns the shop's live method list via `KR.getPaymentMethods()`.

### Patch Changes

- cd165ee: Refine PayZen mappings against the current provider references. CB refusal codes 34 and 41 map to `fraud_suspected` and 38 to `expired_card`; `CLIENT_305` and unmapped CLIENT\_ codes map to a non-retryable `invalid_request` instead of a retryable `processing_error`; transactions in the temporary `INITIAL` state report `processing`; and reads normalize wallet transaction labels onto `paymentMethodType` where PayZen reports them, with unknown methods staying `other`.

## 1.1.1

### Patch Changes

- Updated dependencies [80b9bb6]
- Updated dependencies [d1d42fa]
  - @payfanout/core@2.0.0

## 1.1.0

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

## 1.0.3

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

### Minor Changes

- 1e7559f: Add the PayZen (Lyra) adapter pair: embedded card fields with inline 3DS via krypton-client on the client, and REST API V4 payments, validation capture, refunds, and IPN signature verification on the server (edge-runtime compatible). Confirm-on-client shape — no server-completion route needed.

### Patch Changes

- 0e31e62: The request timeout now covers the response body read. A PSP response that stalled after its headers arrived could previously hang the host's request handler indefinitely; it now rejects with the same retryable `psp_unavailable` timeout error as a connection hang.
- a016891: Adapter plumbing that existed as four-to-five drifting copies now lives once in `@payfanout/core`, and every adapter consumes it: the WebCrypto/base64 helper family (`hmacSha256`, `constantTimeEqual`, …, with the node:crypto bit-equivalence tests moved alongside), the REST transport primitives (`requestWithTimeout` with the timer covering the body read, `withTransportRetries`, `isTransportRetryable`, `safeJson`), the HTTP error tail (`classifyHttpFallback`), capability coherence (`validateAdapterCapabilities`, shared by `PaymentService` and the conformance suite), client SDK loading (`assertBrowser`, `injectScript`), and webhook utilities (`normalizeTime`, `lowercaseKeys`, `normalizeSecrets`). Behavior is unchanged apart from a few user-message strings converging on core's catalog text; all transport timing, retry, and edge-runtime guarantees are preserved and still guard-tested. Core remains zero-dependency and browser-safe.
- Updated dependencies [d68ccbb]
- Updated dependencies [d2c4702]
- Updated dependencies [43569f4]
- Updated dependencies [a016891]
  - @payfanout/core@1.0.0
