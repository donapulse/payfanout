# @payfanout/core

## 4.5.0

### Minor Changes

- 114d13a: Export `NO_CURRENCY` (`"XXX"`, ISO 4217's code for "no currency involved") and `firstCurrencyCode(...codes)`, which returns the first candidate that is three letters once trimmed and uppercased. Adapters report `NO_CURRENCY` as a session's, payment's or subscription's currency when the provider states none and they have no other source they trust, instead of guessing one. It reads with the default exponent 2, so reconcile such a record with the provider before relying on its amounts.
- 2d3cec4: Add `listNonDefaultCurrencyExponents()`, the currencies whose exponent is not the default 2, each with its exponent and in code order, so an adapter can compare its provider's currency table with PayFanout's minor units without enumerating every code; any currency it does not list reads as 2.
- 2d3cec4: Add `AdapterCapabilities.unsupportedCurrencies`, the currencies an adapter refuses to send any amount in (uppercase ISO 4217), for providers that take too many currencies to declare `supportedCurrencies`; an adapter may declare either list or both. `screenSessionInput` refuses a session in one of them, zero-amount sessions included, with the message `"<psp>" declares currency <code> unsupported`, so the router can skip that adapter instead of stopping on its `invalid_request`. `validateAdapterCapabilities` now reports an entry that can never match (not a string, or not three letters once trimmed and uppercased), a currency declared in both lists, and a supported payment method whose `currencies` are all declared unsupported; an entry that works but is not written as its bare uppercase code passes it, and the conformance suite checks that form.

### Patch Changes

- dd0c035: Reject with a non-retryable `invalid_request` from `injectScript` when a page that enforces Trusted Types refuses the script URL, instead of with the browser's bare `TypeError`, which now rides on `raw`; nothing is injected. Such a page needs a default policy that accepts the SDK's URL.

## 4.4.1

### Patch Changes

- 7c1fed9: `getCurrencyExponent("UYI")` now returns ISO 4217's 0 instead of 2, so `toMinorUnits`, `fromMinorUnits` and `formatMinorUnits` treat UYI, the Uruguay peso in indexed units, as whole units: `toMinorUnits("12", "UYI")` is 12 (it was 1200), and fractional UYI amounts are refused. UYI minor-unit amounts computed by earlier versions are 100 times the ISO value.

## 4.4.0

### Minor Changes

- 31c83be: Add `repeatsSecret(text, secrets)`, which reports whether a text holds one of the given secrets, or eight consecutive characters of one, in any letter case. Server adapters call it before quoting a server-written value, such as an error code, in a message, so a credential echoed back by whatever answered a request stays out of that message. An empty secret always counts as repeated, so a blank credential withholds the text.

## 4.3.0

### Minor Changes

- e856737: Add Content-Security-Policy nonce support to the SDK loaders: `injectScript` takes `nonce`, `attributes` and `async`, all set on the `<script>` before its URL and before it is inserted, and rejects an invalid nonce, an `on…` handler, or an attribute it manages or that can stop the script from running (such as `nomodule`) with a non-retryable `invalid_request`, injecting nothing. The new `injectStylesheet(url, pspName, { nonce, integrity, crossOrigin })` adds one `<link rel="stylesheet">` per URL, never mistaking a preload link for it, resolves when the sheet loads and also when it fails, and keeps a failed link on the page, since a browser can report a sheet as failed when one of its `@import`s fails; an empty URL injects nothing. `isValidCspNonce` checks a value against the CSP nonce grammar.

## 4.2.0

### Minor Changes

- 1d66371: Add `PayFanoutError.outcomeUnknown`, set when a call may have taken effect at the provider although its code would otherwise read as definitive; `psp_unavailable`, `rate_limited` and `unknown` already leave the outcome open without it. Retry any such call only under the same idempotency key. `toJSON` includes the flag when it is set.

## 4.1.0

### Minor Changes

- 9eb0ce9: `injectScript` accepts an optional `{ integrity, crossOrigin }` argument that puts Subresource Integrity on the SDK `<script>` it injects, defaulting `crossorigin` to `anonymous` when a hash is given, so the browser refuses a modified file; calls without it are unchanged. When a hash is given, a script already on the page for the same URL is reused only if every script for that URL carries the same `integrity` and a `crossorigin` attribute; a conflicting script, or an `integrity` holding no `sha256`, `sha384` or `sha512` hash, makes the call reject with a non-retryable `invalid_request` without injecting anything. This detects a conflicting script and does not vouch for the page: every shipped client adapter returns before calling `injectScript` once its SDK global exists, so a copy the host page already loaded is used without any check, and since a reused script may still be loading or may have failed, callers keep confirming the SDK global.

### Patch Changes

- c0e5e1f: `injectScript` now removes a script tag it injected when that tag's load fails, so a later `injectScript` call for the same URL fetches the file again instead of resolving at once from the failed tag, including after a failed integrity check.
- 165bb56: The Stripe, Paysafe, PayPal and PayZen client adapters no longer keep a failed SDK load: the next `loadSdk()` or `mount()` call loads the SDK again instead of failing until the page reloads, and PayZen also removes the krypton-client script tag that failed to load so the file is fetched again. `injectScript` now waits for a script tag it injected that is still loading, resolving when that tag loads and rejecting with a retryable `psp_unavailable` when it fails, instead of resolving at once; a script tag the page added itself is still reused at once.

## 4.0.0

### Major Changes

- d500d7d: Model push-only providers in the adapter contract. `AdapterCapabilities` gains three required fields — `supportsPaymentRetrieval`, `supportsRefundRetrieval` and `modificationOutcome` — `retrievePayment` becomes optional, and `PaymentService.retrievePayment` and `retrieveRefund` now reject with `unsupported_operation` when the provider exposes no such read (`retrieveRefund` previously guarded on refund support, which is a separate capability). A provider that only acknowledges captures, cancels and refunds reports `"processing"` and a `"pending"` refund instead of a terminal state it has not confirmed. Both retrieval flags are validated in both directions, so an implemented read cannot be declared absent. The adapters shipped before this release declare full payment and refund retrieval with synchronous modifications, so their behavior is unchanged. They take a major nonetheless: `getCapabilities()` is part of their public surface and now returns an object with additional required fields, and an adapter release that quietly required a new `@payfanout/core` major could leave an application resolving two copies of core.
- 8933b9f: Model what a webhook signature covers in the adapter contract. `AdapterCapabilities` gains a required `webhookSignatureScope: "raw-bytes" | "field-values"`. `"raw-bytes"` means the signature covers bytes as delivered, so any re-encoding of the signed byte range invalidates it; `"field-values"` means the provider signs selected values extracted from the payload, so a re-encoded body still verifies and fields outside the signed set arrive unauthenticated — such an adapter must authenticate the delivery channel by another means and must never present an unsigned field as trusted. `validateAdapterCapabilities` rejects an absent scope rather than letting it disable the assertion it gates. The conformance suite applies its re-serialized-body assertion under `"raw-bytes"` and inverts it under `"field-values"`, which must additionally supply a `webhook.tamperedSignedValueBody` fixture — one signed value altered, signature as delivered — and reject it; rejecting tampered content and credential-less deliveries is still required of every adapter. The adapters shipped before this release all sign raw bytes and declare `"raw-bytes"`, so their verification behavior is unchanged; they take a major because the capability object they return gained a required field.

## 3.0.0

### Major Changes

- eed2987: Add the PSP-native subscription contract. `ServerPaymentAdapter` gains four optional methods — `listNativeSubscriptions` (cursor/limit paging), `retrieveNativeSubscription`, `createNativeSubscription` (server-only, against an already-vaulted instrument), and `cancelNativeSubscription` (verified-idempotent: an already-terminal subscription resolves as success) — operating on a unified `NativeSubscriptionRecord` with integer minor-unit amounts and a normalized status union (`pending | trialing | active | past_due | paused | canceled | completed | unknown`; unmappable provider states become `"unknown"`, never dropped).

  BREAKING CHANGE: `AdapterCapabilities` now requires a `nativeSubscriptions` block declaring each operation separately (`{ list, retrieve, create, cancel }`) — provider support is uneven, so one boolean would either fake or hide support. Adapters without a native subscription product declare all-false; `validateAdapterCapabilities` reports a missing block and checks each declared operation against its implemented method. Custom adapters must add the block to `getCapabilities()`.

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
