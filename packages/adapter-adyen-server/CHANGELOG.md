# @payfanout/adapter-adyen-server

## 1.0.1

### Patch Changes

- 8a36429: Mark `outcomeUnknown` on the `processing_error` of an `errorCode` 704, of any other 409 and of a transient 4xx: each can answer a request sent while another under the same idempotency key is still in progress, which may yet go through, so retry only under that key. The `invalid_request` of a capture or refund whose acknowledgement echoes another amount, and of a completion answered with another request's payment that Adyen did not refuse, fail or cancel, carries `outcomeUnknown` too, since that capture, refund or payment may be the one the call was meant to make: use a new key only once it is known to be another.
- Updated dependencies [1d66371]
  - @payfanout/core@4.2.0

## 1.0.0

### Major Changes

- 4adedb6: Breaking: when upgrading from 0.1.0, check that a malformed `defaultReturnUrl` now throws when the adapter is constructed, and that session creation refuses with `invalid_request` a malformed `returnUrl` (not absolute with a scheme, over 1024 characters once URL-encoded, containing whitespace, or with `//` after the domain) and a `receiptEmail` that is not an address of at most 256 characters. A `paymentMethod` that is not a card or carries unencrypted card fields is refused, and a card one is forwarded with only the fields Adyen Web's Card produces. A `/payments/details` answer that does not name the session's merchant reference and amount reads `processing` with no `pspPaymentId` (its `raw` keeping only `resultCode` and `action`) until the `AUTHORISATION` webhook supplies the reference, and capture, cancel and refund (via `decodeAdyenPaymentRef`) refuse an empty `pspPaymentId`.
  
  Card payments whose `clientToken` from `@payfanout/adapter-adyen` carries the browser data now request native 3-D Secure 2 (`channel: "Web"`, `origin`, `browserInfo`, `nativeThreeDS: "preferred"`), with the risk data and a billing address that is complete and within Adyen's limits; the bare `paymentMethod` token of earlier client adapters still completes. An action answered without a `pspReference` reads `requires_action` with an empty `pspPaymentId` instead of failing with `processing_error`, and an answer naming another merchant reference or amount than the session's is refused with `invalid_request`. The `returnUrl` is sent WHATWG-serialized, so non-ASCII characters are percent-encoded. `shopperEmail` falls back to `billingDetails.email` when that is a usable address. `shopperIP` is not sent, because PayFanout carries no shopper IP address: Adyen's API reference accepts `shopperEmail` in its place for Visa and JCB 3-D Secure 2 payments, while its 3-D Secure guides list `shopperIP` as required, so pass an email and confirm the behaviour in your test account.

### Patch Changes

- 6bb494f: Upgrade note: `/payments` and `/payments/details` now send a different `idempotency-key` than 0.1.0, so a `completePayment` retried by another version than the one that first sent it reaches Adyen as a new request and can charge the shopper twice, since Adyen captures right after authorisation by default. This holds in both directions — an upgrade, a rolling deploy running both versions, or a rollback — so before switching versions stop retrying in-flight completions and settle each one from its `AUTHORISATION` webhook; captures, cancels and refunds send the same key as 0.1.0 and stay deduplicated either way.
  
  The new key covers the merchant account and each 3-D Secure step, so two merchant accounts sharing a caller key, or two steps of one challenge, no longer receive each other's stored answers; captures, cancels and refunds now reject an acknowledgement that lacks its own `pspReference` or echoes another amount, errors follow Adyen's `transient-error` header, error types and codes 704 and 705, refusal reason 31 maps to `fraud_suspected`, and refunds send their `reason` as `merchantRefundReason`.
- 4a57861: The onboarding descriptor now follows Adyen's documentation: the HMAC key pattern accepts exactly the keys the adapter accepts (whole bytes of hex; surrounding whitespace is allowed because the adapter trims it), `liveUrlPrefix` has a pattern that rejects a pasted URL, and the credential hints say where to find the merchant account and live URL prefix, that the API credential needs the Checkout encrypted cardholder data role, and that client key origins must be `https` on live. `csp.frame` and `csp.connect` are now `"*"`, as in Adyen's recommended policy, because issuer 3-D Secure frames load from domains Adyen cannot list; a host that builds its policy from the descriptor gets that automatically. `style-src https://*.adyen.com`, `img-src *` and `form-action *` have no descriptor field and come from the Adyen setup guide.
- 08a0e18: Adyen webhook events now map the outcomes Adyen documents: a refused capture request arrives as `unknown` instead of `payment.failed`, `TECHNICAL_CANCEL` maps like `CANCELLATION`, and the dispute closures `ISSUER_RESPONSE_TIMEFRAME_EXPIRED`, `PREARBITRATION_WON` and `SCHEME_ARBITRATION_WON` arrive as `payment.chargeback_won` and `PREARBITRATION_LOST`, `SCHEME_ARBITRATION_LOST` and `DISPUTE_DEFENSE_PERIOD_ENDED` as `payment.chargeback_lost`, so a later loss can override the provisional win of `CHARGEBACK_REVERSED`. `event.pspPaymentId` comes from `originalReference`, or from the event's own `pspReference` on `AUTHORISATION`, `EXPIRE`, `OFFER_CLOSED` and, until "Include the originalReference for CHARGEBACK_REVERSED events" is enabled, on `CHARGEBACK_REVERSED`, `SECOND_CHARGEBACK` and `PREARBITRATION_WON`/`LOST`; a report notification, or another event without `originalReference`, carries none. Verification checks every signed value against the type Adyen's webhook schema gives it (a `null` in `originalReference` or `merchantReference` reads as absent, as Adyen's validators sign it) and follows Adyen's unescaped join: a `:` or `\` in `merchantReference` now verifies, and a `:` is refused only in the other signed values. A delivery missing a required signed value, or an envelope holding entries that are not notification items, is now refused (answered 401, which Adyen retries), and an undocumented `success` value maps to `unknown` instead of being read as false. Keep the Standard webhook on the JSON method, select `OFFER_CLOSED`, enable "Include the originalReference for CHARGEBACK_REVERSED events", and upsert events by `event.id`, keeping the latest delivery.
- Updated dependencies [c0e5e1f]
- Updated dependencies [9eb0ce9]
- Updated dependencies [165bb56]
  - @payfanout/core@4.1.0

## 0.1.0

### Minor Changes

- c8aae95: Add the Adyen adapter pair. `@payfanout/adapter-adyen-server` drives the Checkout API v72 (payments, manual capture, cancels, refunds, standard webhooks) and is edge-runtime compatible; `@payfanout/adapter-adyen` renders Adyen Web's Card component in Adyen-hosted iframes and resolves 3-D Secure challenges inline. Adyen is push-only — it exposes no read for a payment or a refund and only acknowledges modifications — so the adapter declares `supportsPaymentRetrieval: false`, `supportsRefundRetrieval: false` and `modificationOutcome: "asynchronous"`, reports `"processing"` captures and cancels and `"pending"` refunds, and carries the payment's amount and currency in `pspPaymentId` so captures and refunds work without a read. `returnUrl` is required on every Adyen payment, so sessions carry their own or fall back to the adapter's `defaultReturnUrl`, and the `idempotency-key` sent to Adyen is scoped to the endpoint as well as the caller's key, because Adyen stores those keys per company account rather than per endpoint. Webhook verification checks Adyen's HMAC signature and the endpoint's basic-authentication credentials. Adyen signs eight values extracted from the payload rather than its bytes, so the adapter declares `webhookSignatureScope: "field-values"`; the credentials are what authenticate the channel carrying the fields the signature does not cover.

### Patch Changes

- Updated dependencies [d500d7d]
- Updated dependencies [8933b9f]
  - @payfanout/core@4.0.0
