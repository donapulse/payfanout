---
"@payfanout/core": minor
"@payfanout/server": patch
"@payfanout/conformance": patch
"@payfanout/adapter-stripe-server": patch
"@payfanout/adapter-paysafe-server": patch
"@payfanout/adapter-gocardless-server": patch
"@payfanout/adapter-paypal-server": patch
"@payfanout/adapter-payzen-server": patch
"@payfanout/adapter-stripe": patch
"@payfanout/adapter-paysafe": patch
"@payfanout/adapter-gocardless": patch
"@payfanout/adapter-paypal": patch
"@payfanout/adapter-payzen": patch
---

Adapter plumbing that existed as four-to-five drifting copies now lives once in `@payfanout/core`, and every adapter consumes it: the WebCrypto/base64 helper family (`hmacSha256`, `constantTimeEqual`, …, with the node:crypto bit-equivalence tests moved alongside), the REST transport primitives (`requestWithTimeout` with the timer covering the body read, `withTransportRetries`, `isTransportRetryable`, `safeJson`), the HTTP error tail (`classifyHttpFallback`), capability coherence (`validateAdapterCapabilities`, shared by `PaymentService` and the conformance suite), client SDK loading (`assertBrowser`, `injectScript`), and webhook utilities (`normalizeTime`, `lowercaseKeys`, `normalizeSecrets`). Behavior is unchanged apart from a few user-message strings converging on core's catalog text; all transport timing, retry, and edge-runtime guarantees are preserved and still guard-tested. Core remains zero-dependency and browser-safe.
