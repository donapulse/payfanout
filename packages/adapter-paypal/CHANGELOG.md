# @payfanout/adapter-paypal

## 0.3.0

### Minor Changes

- e856737: Add a `cspNonce` option for pages with a nonce-based Content-Security-Policy: the adapter sets it as both the `nonce` and the `data-csp-nonce` attribute of the PayPal JS SDK `<script>` it injects, as PayPal's nonce-based policy requires, and the SDK applies it to the inline scripts and styles it creates. The constructor rejects a malformed nonce with `invalid_request`.

### Patch Changes

- Updated dependencies [e856737]
  - @payfanout/core@4.3.0

## 0.2.11

### Patch Changes

- 659bc82: Report a failed PayPal button render to the `onError` option once. PayPal's SDK hands the failure to the buttons' `onError` and then rejects the render, which reached the host twice, with conflicting `retryable` flags. Every other error PayPal reports while the buttons render is passed on once too, and a host `onError` or `onReady` that throws after a successful render no longer removes the buttons: its exception is reported as uncaught instead.
- Updated dependencies [1d66371]
  - @payfanout/core@4.2.0

## 0.2.10

### Patch Changes

- f742c9c: The PayPal client adapter now returns the order id from `createOrder` as a Promise, the form PayPal's JS SDK reference documents. Errors the SDK delivers through the buttons' `onError` are now reported as non-retryable `processing_error`, since PayPal documents that callback as a catch-all with nothing to handle beyond a generic error message; a failed button render stays retryable.

## 0.2.9

### Patch Changes

- 165bb56: The Stripe, Paysafe, PayPal and PayZen client adapters no longer keep a failed SDK load: the next `loadSdk()` or `mount()` call loads the SDK again instead of failing until the page reloads, and PayZen also removes the krypton-client script tag that failed to load so the file is fetched again. `injectScript` now waits for a script tag it injected that is still loading, resolving when that tag loads and rejecting with a retryable `psp_unavailable` when it fails, instead of resolving at once; a script tag the page added itself is still reused at once.
- Updated dependencies [c0e5e1f]
- Updated dependencies [9eb0ce9]
- Updated dependencies [165bb56]
  - @payfanout/core@4.1.0

## 0.2.8

### Patch Changes

- Updated dependencies [d500d7d]
- Updated dependencies [8933b9f]
  - @payfanout/core@4.0.0

## 0.2.7

### Patch Changes

- Updated dependencies [eed2987]
  - @payfanout/core@3.0.0

## 0.2.6

### Patch Changes

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

- 6e039c2: Add the PayPal adapter pair. `@payfanout/adapter-paypal` renders PayPal Buttons (the buyer approves in the popup, `onChange({ complete: true })` gates the host's Pay button) and `@payfanout/adapter-paypal-server` drives Orders v2 — capture and authorize flows with multi-capture, refunds, session updates, webhook verification via PayPal's postback API, and missed-event polling — on fetch + WebCrypto only, so it runs on edge runtimes. `paypal` joins the unified payment method types.

### Patch Changes

- Updated dependencies [6e039c2]
  - @payfanout/core@0.2.0
