---
"@payfanout/adapter-payzen-server": patch
---

Map more of the `PSP_` codes PayZen documents instead of reading them as the default `processing_error`: `PSP_707` (the issuer refused the authentication) and the payment refusals such as `PSP_003`, `PSP_091`, `PSP_572`, `PSP_601`, `PSP_624` and `PSP_625` to `card_declined`, the risk-module declines `PSP_641` and `PSP_647` to `fraud_suspected`, the OTP and unfinished 3-D Secure failures (`PSP_649`, `PSP_716`, `PSP_717`, `PSP_722`) to `authentication_required`, `PSP_054`, `PSP_055` and `PSP_718` to `invalid_request`, and every code PayZen's error page gives "Technical error.", "A technical error has occurred." or "Due to a technical problem, we are unable to process your request." to a retryable `psp_unavailable`.
