---
"@payfanout/adapter-adyen-server": patch
---

Upgrade note: `/payments` and `/payments/details` now send a different `idempotency-key` than 0.1.0, so a `completePayment` retried by another version than the one that first sent it reaches Adyen as a new request and can charge the shopper twice, since Adyen captures right after authorisation by default. This holds in both directions — an upgrade, a rolling deploy running both versions, or a rollback — so before switching versions stop retrying in-flight completions and settle each one from its `AUTHORISATION` webhook; captures, cancels and refunds send the same key as 0.1.0 and stay deduplicated either way.

The new key covers the merchant account and each 3-D Secure step, so two merchant accounts sharing a caller key, or two steps of one challenge, no longer receive each other's stored answers; captures, cancels and refunds now reject an acknowledgement that lacks its own `pspReference` or echoes another amount, errors follow Adyen's `transient-error` header, error types and codes 704 and 705, refusal reason 31 maps to `fraud_suspected`, and refunds send their `reason` as `merchantRefundReason`.
