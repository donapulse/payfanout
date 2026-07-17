# @payfanout/adapter-payzen

## 0.3.1

### Patch Changes

- Updated dependencies [eed2987]
  - @payfanout/core@3.0.0

## 0.3.0

### Minor Changes

- 2530a08: Add PayZen's bank rails through the hosted payment page: SEPA Direct Debit (`sepa_debit`), iDEAL (`ideal`), the pay-by-bank family — SEPA Credit Transfer via payment initiation, MyBank, Przelewy24 (`bank_redirect_generic`) — and Multibanco (`voucher_generic`). Sessions requesting a bank rail create a payment order and return the hosted page URL as `clientSecret` (`status: "requires_action"`, `returnUrl` required); the client adapter renders an informational panel, `confirm()` redirects, and the new `handleRedirectReturn` resolves the return trip while the IPN stays the source of truth. Each rail is a per-shop contract and defaults to `supported: false` in the `paymentMethods` capability declaration.
- cd165ee: Add payment-method selection on PayZen. Sessions can restrict the offered methods with `paymentMethodTypes` (mapped onto Charge/CreatePayment's `paymentMethods` field: card, Apple Pay, PayPal — wallet enablement is a per-shop contract declared via the new `paymentMethods` config override on both adapters), and the client adapter renders the multi-method smartForm with `form: "smartform"` or `"smartform-expanded"`, where the form owns its pay buttons and `confirm()` awaits the buyer's in-form completion. The new `fetchAvailablePaymentMethods()` returns the shop's live method list via `KR.getPaymentMethods()`.

### Patch Changes

- cd165ee: Refine PayZen mappings against the current provider references. CB refusal codes 34 and 41 map to `fraud_suspected` and 38 to `expired_card`; `CLIENT_305` and unmapped CLIENT\_ codes map to a non-retryable `invalid_request` instead of a retryable `processing_error`; transactions in the temporary `INITIAL` state report `processing`; and reads normalize wallet transaction labels onto `paymentMethodType` where PayZen reports them, with unknown methods staying `other`.

## 0.2.5

### Patch Changes

- Updated dependencies [80b9bb6]
- Updated dependencies [d1d42fa]
  - @payfanout/core@2.0.0

## 0.2.4

### Patch Changes

- Updated dependencies [3be57b0]
  - @payfanout/core@1.2.0

## 0.2.3

### Patch Changes

- Updated dependencies [66095d1]
  - @payfanout/core@1.1.0

## 0.2.2

### Patch Changes

- b190438: Remove the stale "not yet published to npm" notice from the package README. The package has been available on the public npm registry since its first release.
- Updated dependencies [b190438]
  - @payfanout/core@1.0.2

## 0.2.1

### Patch Changes

- cbb52de: Remove the stale "not yet published to npm" notice from the package README. The package has been available on the public npm registry since its first release.
- Updated dependencies [cbb52de]
  - @payfanout/core@1.0.1

## 0.2.0

### Minor Changes

- 1e7559f: Add the PayZen (Lyra) adapter pair: embedded card fields with inline 3DS via krypton-client on the client, and REST API V4 payments, validation capture, refunds, and IPN signature verification on the server (edge-runtime compatible). Confirm-on-client shape — no server-completion route needed.

### Patch Changes

- d68ccbb: Align client-side error semantics with the hardened contract: the Stripe client adapter no longer marks `authentication_required` confirmation failures as retryable (resolving SCA means bringing the customer back on-session), and the PayZen client adapter reports an expired formToken as `session_expired` instead of `invalid_request`.
- a016891: Adapter plumbing that existed as four-to-five drifting copies now lives once in `@payfanout/core`, and every adapter consumes it: the WebCrypto/base64 helper family (`hmacSha256`, `constantTimeEqual`, …, with the node:crypto bit-equivalence tests moved alongside), the REST transport primitives (`requestWithTimeout` with the timer covering the body read, `withTransportRetries`, `isTransportRetryable`, `safeJson`), the HTTP error tail (`classifyHttpFallback`), capability coherence (`validateAdapterCapabilities`, shared by `PaymentService` and the conformance suite), client SDK loading (`assertBrowser`, `injectScript`), and webhook utilities (`normalizeTime`, `lowercaseKeys`, `normalizeSecrets`). Behavior is unchanged apart from a few user-message strings converging on core's catalog text; all transport timing, retry, and edge-runtime guarantees are preserved and still guard-tested. Core remains zero-dependency and browser-safe.
- Updated dependencies [d68ccbb]
- Updated dependencies [d2c4702]
- Updated dependencies [43569f4]
- Updated dependencies [a016891]
  - @payfanout/core@1.0.0
