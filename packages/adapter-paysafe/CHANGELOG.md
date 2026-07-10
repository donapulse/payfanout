# @payfanout/adapter-paysafe

## 0.2.1

### Patch Changes

- Updated dependencies [3be57b0]
  - @payfanout/core@1.2.0

## 0.2.0

### Minor Changes

- 5999f19: Translate a small cross-PSP appearance token set (`colorPrimary`, `colorText`, `colorDanger`, `colorBackground`, `fontFamily`, `fontSize`) in the hosted-card-field adapters, Stripe and Paysafe, so one `<PaymentFields appearance>` styles either of them. Stripe maps the tokens into its Appearance API `variables`; Paysafe maps the ones its hosted inputs support onto the field `input` selector. PSP-native shapes still pass through for power users, and the Paysafe adapter now warns about appearance entries it cannot apply — e.g. a Stripe `variables` object handed to Paysafe — instead of silently dropping all styling with a cryptic "Invalid css property" from Paysafe.js. Other PSPs (PayPal button, GoCardless panel, PayZen) keep their own native `appearance` shape; the common tokens do not apply to them.

### Patch Changes

- 6ae6ab8: Map Paysafe.js 9003 failures that name a setup/tokenize `options.*` parameter (accountId, currencyCode, merchantRefNum, …) to `invalid_request` instead of `invalid_card_data`. A merchant-configuration error no longer tells the cardholder their card is invalid — so hosts alert on configuration instead of shoppers retyping a valid card — while genuine invalid card fields still surface as `invalid_card_data`.
- 3d8d31f: Coerce a digit-only Paysafe `merchantAccountId` to the numeric form Paysafe.js requires. A `merchantAccountResolver` returning the account id as a string (the documented type) previously failed every tokenize client-side with error 9003 ("Invalid accountId parameter") before any card data was evaluated. The account id is now passed to `fields.setup`/`tokenize` as a number; ids too large to represent exactly are left as strings so one is never silently rounded to a different account.
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
