# @payfanout/conformance

## 2.1.0

### Minor Changes

- eed2987: The server suite now proves the PSP-native subscription surface, gated per declared capability: create round-trips a vaulted instrument into a valid record, retrieve resolves by id, listing honors `limit` and terminates through `nextCursor` without duplicate ids, statuses stay inside the unified union, and cancel is verified-idempotent — a repeated cancel must resolve as success. Adapters declaring any native-subscription operation supply the new `nativeSubscriptions` fixtures (`createInput`, or `seedSubscriptions` for providers without server-only create); all-false adapters skip the cases unchanged.

### Patch Changes

- Updated dependencies [eed2987]
  - @payfanout/core@3.0.0

## 2.0.0

### Major Changes

- 80b9bb6: The capability suites now assert that any `countries` an adapter declares on a payment method are well-formed ISO 3166-1 alpha-2 codes, on both the server and client halves. An adapter declaring malformed country codes will newly fail the suite — a malformed code never matches a session's `customerCountry`, silently screening the rail out instead of gating it.
- d1d42fa: The capability suites now assert that any `currencies` an adapter declares on a payment method are well-formed ISO 4217 codes, on both the server and client halves. An adapter whose method-level currency codes are malformed, or which offers a rail gated to currencies its `supportedCurrencies` excludes, will newly fail the suite — both cases silently disable the rail at routing time.

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

- Updated dependencies [b190438]
  - @payfanout/core@1.0.2

## 1.0.1

### Patch Changes

- Updated dependencies [cbb52de]
  - @payfanout/core@1.0.1

## 1.0.0

### Major Changes

- d68ccbb: Harden the adapter contract. Breaking: `capturePayment`, `cancelPayment`, and `verifyPaymentMethod` now REQUIRE an idempotency key (capture is the canonical double-charge operation; under multi-capture every partial capture carries its own key); `RefundRequest.reason` is typed to `"duplicate" | "fraudulent" | "requested_by_customer"`; capability guards reject with the new `unsupported_operation` code (previously `invalid_request`), expired stateless session tokens with the new `session_expired`; `authentication_required` is never retryable on any adapter; `withRetry`'s `maxDelayMs` is now a hard ceiling with jitter included.

  Additions: `AdapterCapabilities.supportedCurrencies` declares hard PSP currency constraints and the router/service pre-screen them (a PayPal-unsupported currency now skips to the next PSP instead of aborting the cascade); `PaymentInfo` reports `amountCaptured`, `amountCapturable`, and echoes `metadata` where the PSP supports it; `PaymentMethodDetails` carries `expMonth`/`expYear`; webhook events carry normalized `amount`, `currency`, and `refundId` where the payload does; `RetryPolicy.signal` cancels between attempts; new helpers `allocate` (lost-cent-free integer splits), `REFUND_STATUSES`/`RefundStatus`, `isUnifiedWebhookEventType`, `isUnifiedPaymentMethodType`, and the `DATA_PAYFANOUT_FIELD` slot constant.

  The conformance suite now proves the money paths on every adapter — retrieve truth, full/partial/over-refund behavior, pending-refund polling, capture and multi-capture amounts, clean cancellation, unknown-webhook mapping, per-code retryable semantics, and redirect-flow client adapters must implement `handleRedirectReturn`.

### Patch Changes

- 30d9a84: README refresh: correct the runner usage snippet to the real `(name, makeAdapter, fixtures)` signature, document the money-path coverage, and drop the stale "not yet published" notice.
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
