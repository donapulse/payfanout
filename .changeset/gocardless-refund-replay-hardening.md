---
"@payfanout/adapter-gocardless-server": patch
---

While GoCardless reports an amount already refunded on a payment, `refundPayment` now checks the payment's refunds for one made with the same idempotency key before creating a refund, so a key GoCardless no longer honours returns the original refund instead of refunding again. When GoCardless is unavailable for that check, or for the one made after it rejects a create (GoCardless's rejection is then on `raw.rejection`), the call sends nothing further and rejects with a retryable `psp_unavailable`, to be retried with the same key; if GoCardless refuses the check before a create, the refund is not sent and the call rejects with a final `invalid_request`. A blank idempotency key is now refused, a replayed session whose payment awaits the customer's approval reports `processing`, and a refund refused for exceeding what is left now carries the payment on `raw.payment`.
