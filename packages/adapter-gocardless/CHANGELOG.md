# @payfanout/adapter-gocardless

## 0.2.7

### Patch Changes

- Updated dependencies [eed2987]
  - @payfanout/core@3.0.0

## 0.2.6

### Patch Changes

- 80b9bb6: Country-bound rails now declare the customer countries they serve, so a session that states `customerCountry` routes past them when the customer cannot pay with them: iDEAL (NL), ACH (US) and Bacs (GB) on Stripe; Bacs (GB) on GoCardless; Interac e-Transfer (CA) on Paysafe. SEPA stays country-unrestricted on every adapter — the providers document a zone, not a country. As with the currency gates, a `config.paymentMethods` override replaces the declared defaults wholesale, so an override must carry its own `countries` for the router to pre-screen by them.
- d1d42fa: Bank rails now declare the currency they settle in, so the router skips them for a payment they could never have completed: iDEAL and SEPA in EUR, ACH in USD, Bacs in GBP on Stripe; SEPA in EUR and Bacs in GBP on GoCardless. Previously a EUR-only rail looked available for a GBP payment and failed at the PSP.

  Paysafe's Interac e-Transfer declares CAD as well, but the rail stays off by default, and `config.paymentMethods` replaces the declared defaults wholesale — so an account that opts the rail in must carry `currencies: ["CAD"]` in its own override for the router to pre-screen it. The adapter's CAD check is unchanged either way.

- Updated dependencies [80b9bb6]
- Updated dependencies [d1d42fa]
  - @payfanout/core@2.0.0

## 0.2.5

### Patch Changes

- Updated dependencies [3be57b0]
  - @payfanout/core@1.2.0

## 0.2.4

### Patch Changes

- Updated dependencies [66095d1]
  - @payfanout/core@1.1.0

## 0.2.3

### Patch Changes

- b190438: Remove the stale "not yet published to npm" notice from the package README. The package has been available on the public npm registry since its first release.
- Updated dependencies [b190438]
  - @payfanout/core@1.0.2

## 0.2.2

### Patch Changes

- cbb52de: Remove the stale "not yet published to npm" notice from the package README. The package has been available on the public npm registry since its first release.
- Updated dependencies [cbb52de]
  - @payfanout/core@1.0.1

## 0.2.1

### Patch Changes

- a016891: Adapter plumbing that existed as four-to-five drifting copies now lives once in `@payfanout/core`, and every adapter consumes it: the WebCrypto/base64 helper family (`hmacSha256`, `constantTimeEqual`, …, with the node:crypto bit-equivalence tests moved alongside), the REST transport primitives (`requestWithTimeout` with the timer covering the body read, `withTransportRetries`, `isTransportRetryable`, `safeJson`), the HTTP error tail (`classifyHttpFallback`), capability coherence (`validateAdapterCapabilities`, shared by `PaymentService` and the conformance suite), client SDK loading (`assertBrowser`, `injectScript`), and webhook utilities (`normalizeTime`, `lowercaseKeys`, `normalizeSecrets`). Behavior is unchanged apart from a few user-message strings converging on core's catalog text; all transport timing, retry, and edge-runtime guarantees are preserved and still guard-tested. Core remains zero-dependency and browser-safe.
- Updated dependencies [d68ccbb]
- Updated dependencies [d2c4702]
- Updated dependencies [43569f4]
- Updated dependencies [a016891]
  - @payfanout/core@1.0.0

## 0.2.0

### Minor Changes

- 7444bb6: Add the GoCardless bank payments adapter pair. The server adapter creates billing requests with GoCardless-hosted bank authorisation flows and covers retrieval by session or payment id, cancellation, full/partial refunds, event polling, listing, and signature-verified webhooks — including batched deliveries via `parseGoCardlessWebhookEvents`. The client adapter drives the redirect flow (no card fields, no client-side key) and resolves the return trip through `handleRedirectReturn`.

### Patch Changes

- Updated dependencies [6e039c2]
  - @payfanout/core@0.2.0
