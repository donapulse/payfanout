# @payfanout/adapter-paypal

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

- 6e039c2: Add the PayPal adapter pair. `@payfanout/adapter-paypal` renders PayPal Buttons (the buyer approves in the popup, `onChange({ complete: true })` gates the host's Pay button) and `@payfanout/adapter-paypal-server` drives Orders v2 — capture and authorize flows with multi-capture, refunds, session updates, webhook verification via PayPal's postback API, and missed-event polling — on fetch + WebCrypto only, so it runs on edge runtimes. `paypal` joins the unified payment method types.

### Patch Changes

- Updated dependencies [6e039c2]
  - @payfanout/core@0.2.0
