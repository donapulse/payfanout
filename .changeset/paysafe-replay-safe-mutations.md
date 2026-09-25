---
"@payfanout/adapter-paysafe-server": patch
---

Paysafe writes are no longer re-sent blindly: a call whose answer was lost (timeout, dropped connection, server error), or that Paysafe rejects as a duplicate or as already in progress, is answered with the original read back by its reference, and a payment, capture or refund that cannot be read back fails with a non-retryable `processing_error`, to retry later with the same idempotency key. Card, Interac and bank-debit completions now send `dupCheck: false`, so a customer can pay with another card after a decline under the same completion key, while saved-card charges, captures, refunds and verifications keep Paysafe's duplicate check; a key reused for a different amount, currency or card rejects with `invalid_request`. The default `requestTimeoutMs` is now 60 seconds per exchange, matching Paysafe's own SDKs.
