---
"@payfanout/adapter-paypal-server": patch
---

PayPal declines that are not about a single funding source (`PAYMENT_DENIED`, `PAYER_CANNOT_PAY`, `PAYER_ACCOUNT_RESTRICTED`, `PAYER_ACCOUNT_LOCKED_OR_CLOSED`, `MAX_NUMBER_OF_PAYMENT_ATTEMPTS_EXCEEDED`) now reject with `card_declined` and a message asking for another payment method instead of `invalid_request`; `TRANSACTION_BLOCKED_BY_PAYEE` maps to `fraud_suspected` and `TRANSACTION_RECEIVING_LIMIT_EXCEEDED` to `processing_error`. An error named `INTERNAL_SERVER_ERROR`, PayPal's documented name for its HTTP 500, is a retryable `psp_unavailable` whatever status carries it.
