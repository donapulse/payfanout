---
"@payfanout/adapter-worldline-server": patch
---

Map the decline and 3-D Secure error codes Worldline documents, also when Worldline answers with a `REJECTED` payment instead of an error status: a stolen or lost card or a Fraud Prevention rejection is now `fraud_suspected`, and other documented codes give `invalid_card_data`, `expired_card`, `authentication_required`, or `processing_error` for a 3-D Secure failure outside the customer's control. Undocumented codes stay `card_declined`, except that a rejected payment whose error reports a 4xx other than 402 is `invalid_request`. A 429 or 5xx answer now always stays a retryable `rate_limited` or `psp_unavailable`, whatever error code it carries.
