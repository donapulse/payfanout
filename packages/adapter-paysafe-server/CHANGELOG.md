# @payfanout/adapter-paysafe-server

## 2.0.3

### Patch Changes

- 8a36429: Mark `outcomeUnknown` on the `invalid_request` a payment, capture or refund gets when its idempotency key already holds another request's payment, settlement or refund that may have moved money (one not failed, voided, cancelled or expired), since that record may be the money the call was meant to move, and on a bank-debit completion whose key holds another request's spent payment handle while no payment made with it shows. The subscription manager then keeps such a renewal on its key instead of charging again under a new one, and a key whose earlier records moved no money still rejects without the flag.
- 1d66371: Mark the errors that cannot say whether money moved `outcomeUnknown`: the retry-later endings of a replayed write, and the refusals of a key holding several records or a full lookup page. Callers and the subscription manager then retry them only under the same idempotency key.
- 1ba71ec: Paysafe writes are no longer re-sent blindly: a call whose answer was lost (timeout, dropped connection, server error), or that Paysafe rejects as a duplicate or as already in progress, is answered with the original read back by its reference, and a payment, capture or refund that cannot be read back fails with a non-retryable `processing_error`, to retry later with the same idempotency key. Card and Interac completions now send `dupCheck: false`, so a customer can pay with another card after a decline under the same completion key. Bank-debit completions send `dupCheck: true`, so a repeated completion is refused instead of debiting twice while no failed attempt shows under the key, and corrected bank details can still follow a decline; section 10 of the [Paysafe guide](https://donapulse.github.io/payfanout/guide/paysafe#_10-replays-lost-answers-and-timeouts) covers the timings in which a replay can still debit twice, and when a bank-debit key needs replacing. Saved-card charges, captures, refunds and verifications keep Paysafe's duplicate check. A key reused for a different amount or currency, or a different saved card or verification card, rejects with `invalid_request`, unless every earlier attempt under a card or Interac completion key failed. Capture, refund and void state rejections (3203, 3204, 3402, 3404, 3501, 3502, 3506) now map to `invalid_request` instead of `card_declined`. The default `requestTimeoutMs` is now 60 seconds per exchange, matching Paysafe's own SDKs.
- Updated dependencies [1d66371]
  - @payfanout/core@4.2.0

## 2.0.2

### Patch Changes

- ff685ea: Paysafe webhook events now reach the right payment: a bank return reports the returned payment as `pspPaymentId` instead of the return's own id, refund events carry `refundId` without a misleading `pspPaymentId`, and events about other resources (settlements, handles, voids, credits, registrations and unrecognized names) no longer report their own ids as payment ids. `event.id` is now derived from the event name, resource id, status and status time, so every Paysafe redelivery of a notification shares one id; ids therefore differ from earlier releases, a host deduping across the upgrade may process one duplicate of an event delivered around it, and two genuine notifications that agree on all four can share an id, so re-read with `retrievePayment` or `retrieveRefund` before dropping an event as a duplicate — except a bank-debit return, which no documented read reflects: act on the return event itself. `REFUND_CANCELLED` and `REFUND_ERRORED` now map to `payment.refund_failed` and `PAYMENT_ERRORED` to `payment.failed`, the `variables`-nested envelope is read, the documented `Signature` header is matched in any casing, and the onboarding descriptor lists only the event names Paysafe documents.

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

## 1.4.0

### Minor Changes

- eed2987: Add PSP-native subscription support over the Paysafe Payment Scheduler (`subscriptionsplans/v1`), authenticated with the same API key as the Payments API: `listNativeSubscriptions` (offset paging surfaced as an opaque cursor), `retrieveNativeSubscription`, `createNativeSubscription`, and `cancelNativeSubscription`. Creation charges a multi-use payment handle token under `POST /plans/{planId}/subscriptions` — a given `planId` is fetched and validated against the input before anything is created, and without one the adapter mints an open-ended plan inline; `merchantRefNum` doubles as the idempotency channel, with replayed creates recovered by reference lookup. Cancellation PATCHes the final `CANCELLED` status and is verified-idempotent (a rejected cancel re-fetches and treats `CANCELLED`/`COMPLETED` as success). Day, month, and year cadences only — weekly intervals and RRULE schedules reject as `invalid_request`.

### Patch Changes

- Updated dependencies [eed2987]
  - @payfanout/core@3.0.0

## 1.3.0

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

## 1.2.1

### Patch Changes

- 07c97b4: Read the Paysafe webhook event name from `eventName`, the field real Payments-API deliveries use. Previously only `eventType`/`event` were consulted, so genuine deliveries mapped to the `unknown` event type and were acknowledged without effect; `PAYMENT_COMPLETED` and the other documented events now map to their unified types. The top-level `type` field (the resource category) is deliberately ignored.

## 1.2.0

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

## 1.1.0

### Minor Changes

- 66095d1: Accept `billingDetails` on `CompletePaymentInput`. Hosts can now attach AVS billing — typically a postal code collected on the payment step — at completion instead of only at session creation. The Paysafe server adapter merges it over the session's billing before charging, so AVS-enforcing accounts complete without recreating the session (previously they failed with error 3004). Confirm-on-client adapters (Stripe) never call `completePayment` and are unaffected.

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

## 0.1.1

### Patch Changes

- Updated dependencies [6e039c2]
  - @payfanout/core@0.2.0
