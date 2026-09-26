# @payfanout/adapter-payzen

## 0.4.1

### Patch Changes

- bd6a9c4: Map PayZen's AUTH_ errors by what each one says instead of reporting every other one as `authentication_required`: AUTH_100 (invalid ACS signature), AUTH_101 (3-D Secure technical error), AUTH_149 (3-D Secure timeout) and any AUTH_ code PayZen adds later are a non-retryable `processing_error`, and AUTH_102 (wrong 3-D Secure parameter) and AUTH_103 (3-D Secure disabled) are `invalid_request`. AUTH_999 stays a retryable `psp_unavailable`.

## 0.4.0

### Minor Changes

- e856737: Add a `cspNonce` option for pages with a nonce-based Content-Security-Policy: the adapter sets it as the `nonce` attribute of the krypton-client `<script>` and of the theme stylesheet `<link>` it injects, and the constructor rejects a malformed nonce with `invalid_request`. The theme stylesheet is now added once the script has loaded, as PayZen requires theme files to load after the library, without `loadSdk()` waiting for it, and an empty `cssUrl` loads none. A second adapter instance on the page now waits for a krypton-client script another instance is still loading, and fails with it, instead of failing at once with `psp_unavailable` while that load could still succeed.

### Patch Changes

- Updated dependencies [e856737]
  - @payfanout/core@4.3.0

## 0.3.5

### Patch Changes

- 5c9305c: Map the acquirer codes as the server adapter does: 15 is now `invalid_card_data`, and 20, 68, 90, 91, 96, 97 and 99 `processing_error`, instead of `card_declined`, and no acquirer or authentication refusal is retryable. ACQ_999 and AUTH_999, PayZen's technical errors, are a retryable `psp_unavailable`, whether `KR.onError` reports them or an unpaid order carries them, and errors built from these answers carry the core catalog's messages.

## 0.3.4

### Patch Changes

- Updated dependencies [1d66371]
  - @payfanout/core@4.2.0

## 0.3.3

### Patch Changes

- 165bb56: The Stripe, Paysafe, PayPal and PayZen client adapters no longer keep a failed SDK load: the next `loadSdk()` or `mount()` call loads the SDK again instead of failing until the page reloads, and PayZen also removes the krypton-client script tag that failed to load so the file is fetched again. `injectScript` now waits for a script tag it injected that is still loading, resolving when that tag loads and rejecting with a retryable `psp_unavailable` when it fails, instead of resolving at once; a script tag the page added itself is still reused at once.
- Updated dependencies [c0e5e1f]
- Updated dependencies [9eb0ce9]
- Updated dependencies [165bb56]
  - @payfanout/core@4.1.0

## 0.3.2

### Patch Changes

- Updated dependencies [d500d7d]
- Updated dependencies [8933b9f]
  - @payfanout/core@4.0.0

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
