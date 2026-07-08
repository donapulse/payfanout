# @payfanout/adapter-payzen

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
