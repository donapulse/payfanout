# @payfanout/adapter-worldline-server

## 2.0.2

### Patch Changes

- fdc0eb7: Map the decline and 3-D Secure error codes Worldline documents: a stolen or lost card or a Fraud Prevention rejection is now `fraud_suspected`, other documented codes give `invalid_card_data`, `expired_card` or `authentication_required`, a 3-D Secure failure outside the customer's control, an unreachable issuer or an acquirer-side incident gives `processing_error`, and a merchant id the acquirer refuses, a format error or a request 3-D Secure could not run on gives `invalid_request`. A `REJECTED` payment in a 2xx answer now maps from its own errors the same way, and there an undocumented code is `invalid_request` when its error reports a 4xx other than 402, `processing_error` when it reports a 5xx, and `card_declined` otherwise, as on a 402. A 429 or 5xx answer now always stays a retryable `rate_limited` or `psp_unavailable`, whatever error code it carries.
- 8a36429: Mark `outcomeUnknown` on the retryable `processing_error` of a 409, which Worldline returns while the original request under the same idempotency key is still being processed: that request may yet go through, so retry only under that key.
- Updated dependencies [1d66371]
  - @payfanout/core@4.2.0

## 2.0.1

### Patch Changes

- Updated dependencies [c0e5e1f]
- Updated dependencies [9eb0ce9]
- Updated dependencies [165bb56]
  - @payfanout/core@4.1.0

## 2.0.0

### Major Changes

- 9c6e4cf: Send the 3-D Secure data Worldline lists as mandatory on every card payment — the browser device data forwarded by `@payfanout/adapter-worldline`, `threeDSecure.skipAuthentication: false`, the return URL in both documented forms, and a `challenge-required` indicator for `sca: { challenge: "force" }` — and send the statement descriptor as `softDescriptor` instead of the deprecated `descriptor`. Breaking: a return URL is now required per session or through the new `defaultReturnUrl` option (absolute, with a scheme such as `https://` or an app scheme, at most 200 characters; an empty `returnUrl` counts as none, and a malformed `defaultReturnUrl` is refused when the adapter is constructed), so set `defaultReturnUrl` before upgrading, as sessions the previous release created without their own `returnUrl` are otherwise refused at completion. Session creation also refuses, before anything reaches Worldline, a missing or malformed return URL, an `id` longer than 40 characters (Worldline's merchant reference limit) and a `statementDescriptor` longer than 256 characters.

### Patch Changes

- 2c421fb: A capture or cancellation the acquirer refuses now reads `requires_capture` with its authorisation intact instead of `failed` (or `canceled`), an automatic-capture completion answered with a refused capture resolves `requires_capture` instead of throwing `card_declined`, and the `payment.rejected_capture` webhook, like a `payment.rejected` or `payment.cancelled` carrying those refusal codes, parses as `unknown` instead of `payment.failed` or `payment.canceled`. A payment with a refund in flight or refused now reads `succeeded` instead of `processing` or `failed`, a refused refund's `payment.rejected` webhook arrives as `payment.refund_failed` instead of `payment.failed`, and a cancellation still awaiting the acquirer reads `processing` instead of `canceled`. Cancelling a payment Worldline reports as closed now rejects with a non-retryable `invalid_request` instead of a retryable `processing_error`, repeating a cancellation that already took effect answers `canceled` rather than that retryable error, and a partial capture in a currency without two decimals is refused with `invalid_request` rather than risk capturing the wrong amount.
- 86191f3: Webhook event ids are now `worldline:<type>:<payment id>` (the refund id when there is no payment), built only from the pair Worldline documents as identical across duplicate deliveries, since any other field, the envelope id included, may differ on a redelivery and let a duplicate through; payment-link events, `payment.test` messages and deliveries without the pair keep the envelope id, which stays available on `event.raw.id`. Worldline warns that a new payment id per maintenance operation "is not the case in some specific scenarios", so two events of one type on one payment id share an id and a dedupe store drops the second: on every verified `payment.refunded` or `payment.refund_failed` event, and every `unknown` one whose lower-cased `raw.type` starts with `refund.`, re-read with `retrievePayment` (for `amountRefunded`) and `retrieveRefund` (for your refunds still `pending`) whether or not its id was already seen, poll `retrieveRefund` until your refunds leave `pending`, reconcile captured payments with `retrievePayment` on a schedule, and never sum `event.amount` across refund events. For at least 36 hours after upgrading (Worldline retries a delivery for 35 hours 10 minutes), also check `event.raw.id` against the event ids you stored before the upgrade.

## 1.0.0

### Major Changes

- d500d7d: Model push-only providers in the adapter contract. `AdapterCapabilities` gains three required fields — `supportsPaymentRetrieval`, `supportsRefundRetrieval` and `modificationOutcome` — `retrievePayment` becomes optional, and `PaymentService.retrievePayment` and `retrieveRefund` now reject with `unsupported_operation` when the provider exposes no such read (`retrieveRefund` previously guarded on refund support, which is a separate capability). A provider that only acknowledges captures, cancels and refunds reports `"processing"` and a `"pending"` refund instead of a terminal state it has not confirmed. Both retrieval flags are validated in both directions, so an implemented read cannot be declared absent. The adapters shipped before this release declare full payment and refund retrieval with synchronous modifications, so their behavior is unchanged. They take a major nonetheless: `getCapabilities()` is part of their public surface and now returns an object with additional required fields, and an adapter release that quietly required a new `@payfanout/core` major could leave an application resolving two copies of core.
- 8933b9f: Model what a webhook signature covers in the adapter contract. `AdapterCapabilities` gains a required `webhookSignatureScope: "raw-bytes" | "field-values"`. `"raw-bytes"` means the signature covers bytes as delivered, so any re-encoding of the signed byte range invalidates it; `"field-values"` means the provider signs selected values extracted from the payload, so a re-encoded body still verifies and fields outside the signed set arrive unauthenticated — such an adapter must authenticate the delivery channel by another means and must never present an unsigned field as trusted. `validateAdapterCapabilities` rejects an absent scope rather than letting it disable the assertion it gates. The conformance suite applies its re-serialized-body assertion under `"raw-bytes"` and inverts it under `"field-values"`, which must additionally supply a `webhook.tamperedSignedValueBody` fixture — one signed value altered, signature as delivered — and reject it; rejecting tampered content and credential-less deliveries is still required of every adapter. The adapters shipped before this release all sign raw bytes and declare `"raw-bytes"`, so their verification behavior is unchanged; they take a major because the capability object they return gained a required field.

### Patch Changes

- Updated dependencies [d500d7d]
- Updated dependencies [8933b9f]
  - @payfanout/core@4.0.0

## 0.2.0

### Minor Changes

- eed2987: Declare the new native-subscription capability block explicitly all-false: Worldline Direct has no native subscription engine — recurring payments are credential-on-file charges the merchant initiates, which the vault surface and the host-side subscription engine already cover.

### Patch Changes

- Updated dependencies [eed2987]
  - @payfanout/core@3.0.0

## 0.1.0

### Minor Changes

- cf89882: Add Worldline Direct adapter (`@payfanout/adapter-worldline`, `@payfanout/adapter-worldline-server`): Hosted Tokenization Page card payments with manual capture (a partial capture settles that amount and releases the remainder) and refunds. The server adapter is edge-runtime compatible (WebCrypto v1HMAC request signing, no Node builtins) and verifies Worldline webhook signatures.

### Patch Changes

- Updated dependencies [80b9bb6]
- Updated dependencies [d1d42fa]
  - @payfanout/core@2.0.0
