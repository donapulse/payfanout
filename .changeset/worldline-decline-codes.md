---
"@payfanout/adapter-worldline-server": patch
---

Map the decline and 3-D Secure error codes Worldline documents: a stolen or lost card or a Fraud Prevention rejection is now `fraud_suspected`, other documented codes give `invalid_card_data`, `expired_card` or `authentication_required`, a 3-D Secure failure outside the customer's control or an unreachable issuer gives `processing_error`, and a merchant id the acquirer refuses, a format error or a request 3-D Secure could not run on gives `invalid_request`. A `REJECTED` payment in a 2xx answer now maps from its own errors the same way, and there an undocumented code is `invalid_request` when its error reports a 4xx other than 402, `processing_error` when it reports a 5xx, and `card_declined` otherwise, as on a 402. A 429 or 5xx answer now always stays a retryable `rate_limited` or `psp_unavailable`, whatever error code it carries.
