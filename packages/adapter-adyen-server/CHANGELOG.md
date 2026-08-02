# @payfanout/adapter-adyen-server

## 0.1.0

### Minor Changes

- c8aae95: Add the Adyen adapter pair. `@payfanout/adapter-adyen-server` drives the Checkout API v72 (payments, manual capture, cancels, refunds, standard webhooks) and is edge-runtime compatible; `@payfanout/adapter-adyen` renders Adyen Web's Card component in Adyen-hosted iframes and resolves 3-D Secure challenges inline. Adyen is push-only — it exposes no read for a payment or a refund and only acknowledges modifications — so the adapter declares `supportsPaymentRetrieval: false`, `supportsRefundRetrieval: false` and `modificationOutcome: "asynchronous"`, reports `"processing"` captures and cancels and `"pending"` refunds, and carries the payment's amount and currency in `pspPaymentId` so captures and refunds work without a read. `returnUrl` is required on every Adyen payment, so sessions carry their own or fall back to the adapter's `defaultReturnUrl`, and the `idempotency-key` sent to Adyen is scoped to the endpoint as well as the caller's key, because Adyen stores those keys per company account rather than per endpoint. Webhook verification checks Adyen's HMAC signature and the endpoint's basic-authentication credentials. Adyen signs eight values extracted from the payload rather than its bytes, so the adapter declares `webhookSignatureScope: "field-values"`; the credentials are what authenticate the channel carrying the fields the signature does not cover.

### Patch Changes

- Updated dependencies [d500d7d]
- Updated dependencies [8933b9f]
  - @payfanout/core@4.0.0
