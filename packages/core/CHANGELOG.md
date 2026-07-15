# @payfanout/core

## 2.0.0

### Major Changes

- d1d42fa: Payment methods can now declare the currencies they settle in. `PaymentMethodCapability.currencies` (uppercase ISO 4217; absent or empty means unrestricted, and the PSP-wide `supportedCurrencies` still applies on top) is honored by session screening, so a rail requested outside its currencies — SEPA in GBP — is reported ineligible instead of attempted, and the router can fail over to a PSP that settles it.

  Adds `pad` to `PAYMENT_METHOD_TYPES` for Pre-Authorized Debit, the Payments Canada scheme that Stripe calls `acss_debit`, GoCardless calls `pad`, and Paysafe calls EFT. This widens `UnifiedPaymentMethodType`: an exhaustive `switch` or a non-partial `Record` over it will need a `pad` arm.

  `validateAdapterCapabilities` now reports a supported method gated to currencies that the adapter's own `supportedCurrencies` excludes — such a method can never be routed, so `PaymentService` rejects it at registration rather than offering a rail that always screens out.

### Minor Changes

- 80b9bb6: Payment methods can now declare the customer countries they serve. `PaymentMethodCapability.countries` (uppercase ISO 3166-1 alpha-2; absent or empty means unrestricted) is the customer-side sibling of `currencies`: Bacs pays from UK bank accounts, Interac from Canadian ones. Session screening honors it through a new `CreatePaymentSessionInput.customerCountry` field — when the host states the customer's country, a rail that cannot serve it is reported ineligible and the router can fail over; when the host omits it, country-restricted rails are not screened at all, so existing callers see no change. `customerCountry` is distinct from `country`, which resolves the merchant account and is never read for rail eligibility.

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

## 1.1.0

### Minor Changes

- 66095d1: Accept `billingDetails` on `CompletePaymentInput`. Hosts can now attach AVS billing — typically a postal code collected on the payment step — at completion instead of only at session creation. The Paysafe server adapter merges it over the session's billing before charging, so AVS-enforcing accounts complete without recreating the session (previously they failed with error 3004). Confirm-on-client adapters (Stripe) never call `completePayment` and are unaffected.

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
