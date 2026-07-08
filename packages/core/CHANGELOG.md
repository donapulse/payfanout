# @payfanout/core

## 1.0.2

### Patch Changes

- b190438: Remove the stale "not yet published to npm" notice from the package README. The package has been available on the public npm registry since its first release.

## 1.0.1

### Patch Changes

- cbb52de: Remove the stale "not yet published to npm" notice from the package README. The package has been available on the public npm registry since its first release.

## 1.0.0

### Major Changes

- d68ccbb: Harden the adapter contract. Breaking: `capturePayment`, `cancelPayment`, and `verifyPaymentMethod` now REQUIRE an idempotency key (capture is the canonical double-charge operation; under multi-capture every partial capture carries its own key); `RefundRequest.reason` is typed to `"duplicate" | "fraudulent" | "requested_by_customer"`; capability guards reject with the new `unsupported_operation` code (previously `invalid_request`), expired stateless session tokens with the new `session_expired`; `authentication_required` is never retryable on any adapter; `withRetry`'s `maxDelayMs` is now a hard ceiling with jitter included.

  Additions: `AdapterCapabilities.supportedCurrencies` declares hard PSP currency constraints and the router/service pre-screen them (a PayPal-unsupported currency now skips to the next PSP instead of aborting the cascade); `PaymentInfo` reports `amountCaptured`, `amountCapturable`, and echoes `metadata` where the PSP supports it; `PaymentMethodDetails` carries `expMonth`/`expYear`; webhook events carry normalized `amount`, `currency`, and `refundId` where the payload does; `RetryPolicy.signal` cancels between attempts; new helpers `allocate` (lost-cent-free integer splits), `REFUND_STATUSES`/`RefundStatus`, `isUnifiedWebhookEventType`, `isUnifiedPaymentMethodType`, and the `DATA_PAYFANOUT_FIELD` slot constant.

  The conformance suite now proves the money paths on every adapter — retrieve truth, full/partial/over-refund behavior, pending-refund polling, capture and multi-capture amounts, clean cancellation, unknown-webhook mapping, per-code retryable semantics, and redirect-flow client adapters must implement `handleRedirectReturn`.

### Minor Changes

- 43569f4: Session capability screening is now a single shared predicate, `screenSessionInput` (exported from `@payfanout/core`), consumed by both `PaymentService` and `PaymentRouter`. The two hand-mirrored copies had drifted: the router wrongly skipped zero-amount save-card sessions that the service accepts, and a vault session whose first candidate lacked `supportsSavedPaymentMethods` aborted the whole failover cascade instead of skipping to a capable PSP. The service now also pre-screens requested payment-method types before spending a PSP call, exactly as the router always did.
- a016891: Adapter plumbing that existed as four-to-five drifting copies now lives once in `@payfanout/core`, and every adapter consumes it: the WebCrypto/base64 helper family (`hmacSha256`, `constantTimeEqual`, …, with the node:crypto bit-equivalence tests moved alongside), the REST transport primitives (`requestWithTimeout` with the timer covering the body read, `withTransportRetries`, `isTransportRetryable`, `safeJson`), the HTTP error tail (`classifyHttpFallback`), capability coherence (`validateAdapterCapabilities`, shared by `PaymentService` and the conformance suite), client SDK loading (`assertBrowser`, `injectScript`), and webhook utilities (`normalizeTime`, `lowercaseKeys`, `normalizeSecrets`). Behavior is unchanged apart from a few user-message strings converging on core's catalog text; all transport timing, retry, and edge-runtime guarantees are preserved and still guard-tested. Core remains zero-dependency and browser-safe.

### Patch Changes

- d2c4702: Error-handling correctness. `PayFanoutError.wrap` no longer copies an arbitrary thrown error's text into the user-facing `message` — absent an explicit fallback it uses the built-in user-safe catalog message for the code, with the original error preserved on `raw`. `isPayFanoutError` (and therefore `wrap`) now recognizes errors structurally, so adapters resolving a duplicated copy of core keep their specific codes instead of being re-wrapped as `unknown`. `localizeError` resolves missing codes per key through the locale chain, matching `getUserMessage`, instead of falling back to English whenever a region catalog exists. `normalizeCurrency` accepts surrounding whitespace.

## 0.2.0

### Minor Changes

- 6e039c2: Add the PayPal adapter pair. `@payfanout/adapter-paypal` renders PayPal Buttons (the buyer approves in the popup, `onChange({ complete: true })` gates the host's Pay button) and `@payfanout/adapter-paypal-server` drives Orders v2 — capture and authorize flows with multi-capture, refunds, session updates, webhook verification via PayPal's postback API, and missed-event polling — on fetch + WebCrypto only, so it runs on edge runtimes. `paypal` joins the unified payment method types.
