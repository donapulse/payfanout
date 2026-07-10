# @payfanout/server

## 1.0.3

### Patch Changes

- Updated dependencies [66095d1]
  - @payfanout/core@1.1.0

## 1.0.2

### Patch Changes

- b190438: Remove the stale "not yet published to npm" notice from the package README. The package has been available on the public npm registry since its first release.
- Updated dependencies [b190438]
  - @payfanout/core@1.0.2

## 1.0.1

### Patch Changes

- cbb52de: Remove the stale "not yet published to npm" notice from the package README. The package has been available on the public npm registry since its first release.
- Updated dependencies [cbb52de]
  - @payfanout/core@1.0.1

## 1.0.0

### Major Changes

- d68ccbb: Harden the adapter contract. Breaking: `capturePayment`, `cancelPayment`, and `verifyPaymentMethod` now REQUIRE an idempotency key (capture is the canonical double-charge operation; under multi-capture every partial capture carries its own key); `RefundRequest.reason` is typed to `"duplicate" | "fraudulent" | "requested_by_customer"`; capability guards reject with the new `unsupported_operation` code (previously `invalid_request`), expired stateless session tokens with the new `session_expired`; `authentication_required` is never retryable on any adapter; `withRetry`'s `maxDelayMs` is now a hard ceiling with jitter included.

  Additions: `AdapterCapabilities.supportedCurrencies` declares hard PSP currency constraints and the router/service pre-screen them (a PayPal-unsupported currency now skips to the next PSP instead of aborting the cascade); `PaymentInfo` reports `amountCaptured`, `amountCapturable`, and echoes `metadata` where the PSP supports it; `PaymentMethodDetails` carries `expMonth`/`expYear`; webhook events carry normalized `amount`, `currency`, and `refundId` where the payload does; `RetryPolicy.signal` cancels between attempts; new helpers `allocate` (lost-cent-free integer splits), `REFUND_STATUSES`/`RefundStatus`, `isUnifiedWebhookEventType`, `isUnifiedPaymentMethodType`, and the `DATA_PAYFANOUT_FIELD` slot constant.

  The conformance suite now proves the money paths on every adapter — retrieve truth, full/partial/over-refund behavior, pending-refund polling, capture and multi-capture amounts, clean cancellation, unknown-webhook mapping, per-code retryable semantics, and redirect-flow client adapters must implement `handleRedirectReturn`.

### Minor Changes

- dffd211: Harden subscription renewals against double charges and unconfirmed money. A bookkeeping failure after a successful renewal charge no longer enters dunning (which would re-charge under a fresh idempotency key) — it surfaces in the new `ChargeDueResult.errors` and the next run replays the same attempt key. Renewal charges that resolve as `"processing"` now freeze the subscription with a `pendingRenewal` marker until `resolvePendingRenewal` applies the real outcome from your webhook ingress; charges that resolve as failed enter dunning instead of being recorded as paid. A cancellation racing an in-flight renewal is no longer resurrected, and one subscription's storage failure no longer abandons the rest of the cron run.
- 2997817: Subscription lifecycle and router observability. Subscriptions gain pause/resume (`pauseSubscription`/`resumeSubscription` — a lapsed resume re-charges with the caller's idempotency key and the same money-safety discipline as renewals, and resume refuses to charge over an unresolved pending renewal), a distinguishable `trialing` status with eager capability validation at creation, a `subscription.updated` event plus `occurredAt` on every event, month-end anchor preservation (`anchorDay` — a subscription created Jan 31 now bills Feb 28, Mar 31, Apr 30 instead of eroding to the 28th), and the optional `SubscriptionStore.listDue` seam so hosts can push due-ness into a database index instead of full-table scans. `PaymentRouter` exposes `getBreakerState()` and an exception-isolated `onBreakerStateChange` hook for circuit-breaker observability.

### Patch Changes

- be3969a: Observability can no longer break payments: exceptions thrown by the router's `onAttempt` hook and the webhook handlers' `log` option are swallowed, matching the existing telemetry and `onEvent` behavior. Every rejection leaving `PaymentService` now carries `pspName` even when the adapter omitted it, and the error thrown after a failover cascade keeps the per-candidate audit trail under `raw.attempts`.
- 43569f4: Session capability screening is now a single shared predicate, `screenSessionInput` (exported from `@payfanout/core`), consumed by both `PaymentService` and `PaymentRouter`. The two hand-mirrored copies had drifted: the router wrongly skipped zero-amount save-card sessions that the service accepts, and a vault session whose first candidate lacked `supportsSavedPaymentMethods` aborted the whole failover cascade instead of skipping to a capable PSP. The service now also pre-screens requested payment-method types before spending a PSP call, exactly as the router always did.
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
