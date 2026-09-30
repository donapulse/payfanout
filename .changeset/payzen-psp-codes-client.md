---
"@payfanout/adapter-payzen": patch
---

Classify PayZen's `PSP_` codes through the server adapter's map, whether `KR.onError` reports them or they sit on an unpaid order's last transaction: a failed or unfinished 3-D Secure (`PSP_539`, `PSP_649`, `PSP_716`, `PSP_717`, `PSP_722`) is `authentication_required`, the issuer's refusal of the authentication (`PSP_707`) and the payment refusals PayZen documents are `card_declined`, risk-module declines are `fraud_suspected`, and PayZen's technical errors are a retryable `psp_unavailable`. A `PSP_` answer from `KR.onError` is retryable only for such an outage or a rate limit, so a smartForm host that retries on a retryable failure stops retrying on the others, and a code the map does not list reads as `processing_error` on an unpaid transaction too, where it read as `card_declined`. A `PSP_` code's own `detailedErrorCode` is no longer read as an acquirer's refusal code.
