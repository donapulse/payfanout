# @payfanout/adapter-paysafe

## 0.3.1

### Patch Changes

- Updated dependencies [eed2987]
  - @payfanout/core@3.0.0

## 0.3.0

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
