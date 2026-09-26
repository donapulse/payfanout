# @payfanout/adapter-stripe

## 0.3.0

### Minor Changes

- e856737: Add a `cspNonce` option for pages with a nonce-based Content-Security-Policy: the adapter sets it as the `nonce` attribute of the Stripe.js `<script>` it injects, and the constructor rejects a malformed nonce with `invalid_request`. The Stripe guide lists what Stripe.js still loads without a nonce.

### Patch Changes

- Updated dependencies [e856737]
  - @payfanout/core@4.3.0

## 0.2.7

### Patch Changes

- a17cd12: Classify Stripe.js errors as the server adapter does: `expired_payment_method` is `expired_card`, `incorrect_zip` and `incorrect_postal_code` are `invalid_card_data`, and the fraud decline codes (`fraudulent`, `stolen_card`, `lost_card`, `merchant_blacklist`, `lost_or_stolen_card`) are `fraud_suspected`, taking precedence over a failed authentication on the same error. A fraud decline shows core's generic message in the locale Stripe.js was given (the browser's under `"auto"`), falling back to English; every other error keeps Stripe.js's localized message.

## 0.2.6

### Patch Changes

- 70e9679: Map Stripe.js's `authentication_failure` (a payment method that failed authentication) to `authentication_required`, like the intent-specific authentication failures, instead of `card_declined`.
- Updated dependencies [1d66371]
  - @payfanout/core@4.2.0

## 0.2.5

### Patch Changes

- 165bb56: The Stripe, Paysafe, PayPal and PayZen client adapters no longer keep a failed SDK load: the next `loadSdk()` or `mount()` call loads the SDK again instead of failing until the page reloads, and PayZen also removes the krypton-client script tag that failed to load so the file is fetched again. `injectScript` now waits for a script tag it injected that is still loading, resolving when that tag loads and rejecting with a retryable `psp_unavailable` when it fails, instead of resolving at once; a script tag the page added itself is still reused at once.
- Updated dependencies [c0e5e1f]
- Updated dependencies [9eb0ce9]
- Updated dependencies [165bb56]
  - @payfanout/core@4.1.0

## 0.2.4

### Patch Changes

- Updated dependencies [d500d7d]
- Updated dependencies [8933b9f]
  - @payfanout/core@4.0.0

## 0.2.3

### Patch Changes

- Updated dependencies [eed2987]
  - @payfanout/core@3.0.0

## 0.2.2

### Patch Changes

- 80b9bb6: Country-bound rails now declare the customer countries they serve, so a session that states `customerCountry` routes past them when the customer cannot pay with them: iDEAL (NL), ACH (US) and Bacs (GB) on Stripe; Bacs (GB) on GoCardless; Interac e-Transfer (CA) on Paysafe. SEPA stays country-unrestricted on every adapter — the providers document a zone, not a country. As with the currency gates, a `config.paymentMethods` override replaces the declared defaults wholesale, so an override must carry its own `countries` for the router to pre-screen by them.
- d1d42fa: Bank rails now declare the currency they settle in, so the router skips them for a payment they could never have completed: iDEAL and SEPA in EUR, ACH in USD, Bacs in GBP on Stripe; SEPA in EUR and Bacs in GBP on GoCardless. Previously a EUR-only rail looked available for a GBP payment and failed at the PSP.

  Paysafe's Interac e-Transfer declares CAD as well, but the rail stays off by default, and `config.paymentMethods` replaces the declared defaults wholesale — so an account that opts the rail in must carry `currencies: ["CAD"]` in its own override for the router to pre-screen it. The adapter's CAD check is unchanged either way.

- Updated dependencies [80b9bb6]
- Updated dependencies [d1d42fa]
  - @payfanout/core@2.0.0

## 0.2.1

### Patch Changes

- Updated dependencies [3be57b0]
  - @payfanout/core@1.2.0

## 0.2.0

### Minor Changes

- 5999f19: Translate a small cross-PSP appearance token set (`colorPrimary`, `colorText`, `colorDanger`, `colorBackground`, `fontFamily`, `fontSize`) in the hosted-card-field adapters, Stripe and Paysafe, so one `<PaymentFields appearance>` styles either of them. Stripe maps the tokens into its Appearance API `variables`; Paysafe maps the ones its hosted inputs support onto the field `input` selector. PSP-native shapes still pass through for power users, and the Paysafe adapter now warns about appearance entries it cannot apply — e.g. a Stripe `variables` object handed to Paysafe — instead of silently dropping all styling with a cryptic "Invalid css property" from Paysafe.js. Other PSPs (PayPal button, GoCardless panel, PayZen) keep their own native `appearance` shape; the common tokens do not apply to them.

### Patch Changes

- Updated dependencies [66095d1]
  - @payfanout/core@1.1.0

## 0.1.4

### Patch Changes

- b190438: Remove the stale "not yet published to npm" notice from the package README. The package has been available on the public npm registry since its first release.
- Updated dependencies [b190438]
  - @payfanout/core@1.0.2

## 0.1.3

### Patch Changes

- cbb52de: Remove the stale "not yet published to npm" notice from the package README. The package has been available on the public npm registry since its first release.
- Updated dependencies [cbb52de]
  - @payfanout/core@1.0.1

## 0.1.2

### Patch Changes

- d68ccbb: Align client-side error semantics with the hardened contract: the Stripe client adapter no longer marks `authentication_required` confirmation failures as retryable (resolving SCA means bringing the customer back on-session), and the PayZen client adapter reports an expired formToken as `session_expired` instead of `invalid_request`.
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
