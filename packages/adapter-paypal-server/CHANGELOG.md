# @payfanout/adapter-paypal-server

## 2.0.5

### Patch Changes

- Updated dependencies [e856737]
  - @payfanout/core@4.3.0

## 2.0.4

### Patch Changes

- 8a36429: Mark `outcomeUnknown` on the retryable `processing_error` of a 409, which PayPal's Payments API returns on an authorization's capture or void and on a capture's refund while a previous request on it is in progress: that request can be the call's own first one under the same `PayPal-Request-Id`, so retry only under the same idempotency key. The Orders API's 409 on an order's authorize or capture, which PayPal documents as a conflict with the order's state, is marked the same way through the shared error mapper.
- 780a70c: Capture and report a manual-capture payment against its newest authorization, so a reauthorization made through PayPal is honoured, while `cancelPayment` still voids the original authorization, as PayPal requires. Capturing the rest, and `amountCapturable`, never exceed what the order has left, even when the reauthorization holds the full amount again, and a capture PayPal ties to no authorization counts only against the authorizations that existed when it was taken. When what is left can only be estimated, the capture keeps the authorization open rather than closing it.
- Updated dependencies [1d66371]
  - @payfanout/core@4.2.0

## 2.0.3

### Patch Changes

- 9f499d7: The PayPal server adapter now refuses with `invalid_request`, before calling PayPal, what PayPal would reject: a zero amount on sessions, updates, captures and refunds, and a session `id` longer than 255 characters (PayPal's `custom_id` limit). At construction it refuses a `brandName` longer than 127 characters or containing a line break; an empty one is still omitted. `fetchEvents` accepts as a cursor only the events-list path it hands out.
- c199ff9: `updatePaymentSession` patches shipping through the name and address attributes PayPal documents, so updating the shipping of an order that already has one no longer fails (the failure also discarded any amount change sent with it). Adding a statement descriptor to an order created without one is now refused with `invalid_request` before any update, since PayPal can only replace or remove one, and `createPaymentSession` and `updatePaymentSession` now cut a statement descriptor longer than 22 characters to 22, as PayPal does, instead of leaving it out.

## 2.0.2

### Patch Changes

- 3c42f70: `capturePayment` without an amount now captures only the uncaptured remainder of a PayPal authorization; earlier versions asked PayPal for the full authorized amount again, which PayPal's overage limit could accept after a partial capture, so review manual-capture payments captured that way. A capture that reaches the remainder, with or without an amount, now closes the authorization and later captures against it are refused; capturing the rest of a fully captured payment returns the payment without sending a capture to PayPal, capturing the rest of a voided or denied authorization rejects with `invalid_request`, and capturing and cancelling accept the capture id an earlier capture returned. `amountRefunded` leaves out failed and cancelled refunds, a completion repeated under a new idempotency key returns the existing capture or authorization instead of failing, refund reason codes are no longer sent to the payer as `note_to_payer`, Venmo-funded orders report `paymentMethodDetails.wallet: "venmo"`, and a payment read from a capture whose order has aged out leaves `paymentMethodDetails` out instead of reporting the PayPal wallet.
- 21ab46d: PayPal declines that are not about a single funding source (`PAYMENT_DENIED`, `PAYER_CANNOT_PAY`, `PAYER_ACCOUNT_RESTRICTED`, `PAYER_ACCOUNT_LOCKED_OR_CLOSED`, `MAX_NUMBER_OF_PAYMENT_ATTEMPTS_EXCEEDED`) now reject with `card_declined` and a message asking for another payment method instead of `invalid_request`; `TRANSACTION_BLOCKED_BY_PAYEE` maps to `fraud_suspected` and `TRANSACTION_RECEIVING_LIMIT_EXCEEDED` to `processing_error`. An error named `INTERNAL_SERVER_ERROR`, PayPal's documented name for its HTTP 500, is a retryable `psp_unavailable` whatever status carries it.
- c0a97b3: The PayPal server adapter no longer offers RUB, which PayPal's currency codes reference no longer lists. `supportedCurrencies` leaves it out, so `PaymentRouter` skips PayPal for a RUB payment and `PaymentService` refuses a RUB session for PayPal with `unsupported_operation`; the adapter itself refuses a new RUB session, or moving an order to RUB, with `invalid_request` before creating or changing the order. Payments made in RUB earlier can still be retrieved, captured and refunded.
- 642eca0: `CHECKOUT.PAYMENT-APPROVAL.REVERSED` webhook events now carry the order id as `pspPaymentId`, read from `resource.order_id` where PayPal sends it, and `verifyWebhookSignature` answers `false` without calling PayPal for a body that is not exactly one JSON object. The onboarding descriptor's CSP lists `*.paypalobjects.com` and `*.venmo.com` for scripts, frames and connections, as PayPal recommends.

## 2.0.1

### Patch Changes

- Updated dependencies [c0e5e1f]
- Updated dependencies [9eb0ce9]
- Updated dependencies [165bb56]
  - @payfanout/core@4.1.0

## 2.0.0

### Major Changes

- d500d7d: Model push-only providers in the adapter contract. `AdapterCapabilities` gains three required fields — `supportsPaymentRetrieval`, `supportsRefundRetrieval` and `modificationOutcome` — `retrievePayment` becomes optional, and `PaymentService.retrievePayment` and `retrieveRefund` now reject with `unsupported_operation` when the provider exposes no such read (`retrieveRefund` previously guarded on refund support, which is a separate capability). A provider that only acknowledges captures, cancels and refunds reports `"processing"` and a `"pending"` refund instead of a terminal state it has not confirmed. Both retrieval flags are validated in both directions, so an implemented read cannot be declared absent. The adapters shipped before this release declare full payment and refund retrieval with synchronous modifications, so their behavior is unchanged. They take a major nonetheless: `getCapabilities()` is part of their public surface and now returns an object with additional required fields, and an adapter release that quietly required a new `@payfanout/core` major could leave an application resolving two copies of core.
- 8933b9f: Model what a webhook signature covers in the adapter contract. `AdapterCapabilities` gains a required `webhookSignatureScope: "raw-bytes" | "field-values"`. `"raw-bytes"` means the signature covers bytes as delivered, so any re-encoding of the signed byte range invalidates it; `"field-values"` means the provider signs selected values extracted from the payload, so a re-encoded body still verifies and fields outside the signed set arrive unauthenticated — such an adapter must authenticate the delivery channel by another means and must never present an unsigned field as trusted. `validateAdapterCapabilities` rejects an absent scope rather than letting it disable the assertion it gates. The conformance suite applies its re-serialized-body assertion under `"raw-bytes"` and inverts it under `"field-values"`, which must additionally supply a `webhook.tamperedSignedValueBody` fixture — one signed value altered, signature as delivered — and reject it; rejecting tampered content and credential-less deliveries is still required of every adapter. The adapters shipped before this release all sign raw bytes and declare `"raw-bytes"`, so their verification behavior is unchanged; they take a major because the capability object they return gained a required field.

### Patch Changes

- Updated dependencies [d500d7d]
- Updated dependencies [8933b9f]
  - @payfanout/core@4.0.0

## 1.2.0

### Minor Changes

- eed2987: Add PSP-native subscription support over the PayPal Subscriptions v1 API: `listNativeSubscriptions` (page-number pagination surfaced as an opaque cursor), `retrieveNativeSubscription`, and `cancelNativeSubscription`. Creation is deliberately not offered (`nativeSubscriptions.create: false`): PayPal subscription creation is buyer-approval-gated, so a server-only create against a vaulted token would fake support. Amounts resolve from the plan's regular billing cycle via `?fields=plan` — per-unit price times the subscription quantity — falling back to the last collected payment for tier-priced plans, and degrading to zero with the provider payload preserved on `raw` when no documented amount source exists; list pages complete each item with a detail request. Cancellation sends the required reason and is verified-idempotent: a `SUBSCRIPTION_STATUS_INVALID` rejection re-fetches and treats already-cancelled or expired subscriptions as success. Statuses map into the unified union (`APPROVAL_PENDING`/`APPROVED` to `pending`, `SUSPENDED` to `paused`, `EXPIRED` to `completed`).

### Patch Changes

- Updated dependencies [eed2987]
  - @payfanout/core@3.0.0

## 1.1.1

### Patch Changes

- Updated dependencies [80b9bb6]
- Updated dependencies [d1d42fa]
  - @payfanout/core@2.0.0

## 1.1.0

### Minor Changes

- 3be57b0: Add a declarative adapter onboarding descriptor and an optional credential probe.
  `@payfanout/core` exports `AdapterOnboardingDescriptor` — credential-field metadata (kind,
  scope, format hints, per-currency), the webhook signature scheme and event list, and CSP
  hosts — plus `validateOnboardingDescriptor`, and `ServerPaymentAdapter` gains an optional
  `verifyCredentials()` that reports whether the configured credentials authenticate (auth vs
  network vs internal). Every server adapter (Stripe, Paysafe, PayPal, PayZen, GoCardless) now
  exports a descriptor and implements `verifyCredentials`, and the conformance suite validates
  each descriptor against its adapter. Hosts can render provider-settings forms, validate
  credential shapes, drive webhook-subscription copy, build CSP headers, and offer a "Test
  connection" button as generic loops over the descriptor — identical for every adapter.

### Patch Changes

- Updated dependencies [3be57b0]
  - @payfanout/core@1.2.0

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

### Patch Changes

- 8b720a8: Per-adapter consistency: the Stripe server config gains a `paymentMethods` override (dashboard enablement varies per account — stop hardcoding iDEAL/SEPA/ACH/BACS as supported) and `requestTimeoutMs` (threaded to the SDK's timeout, default remains the SDK's 80s); `listSavedPaymentMethods` pages past 100 stored methods instead of silently truncating. Paysafe error 3004 (billing zip required) now maps to `invalid_request` instead of masquerading as a card decline. All REST adapters validate `maxNetworkRetries` as an integer ≥ 0 at construction, Stripe validates `webhookToleranceSeconds`, and GoCardless clamps list page sizes to its documented 1–500 bounds.
- 0e31e62: The request timeout now covers the response body read. A PSP response that stalled after its headers arrived could previously hang the host's request handler indefinitely; it now rejects with the same retryable `psp_unavailable` timeout error as a connection hang.
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
