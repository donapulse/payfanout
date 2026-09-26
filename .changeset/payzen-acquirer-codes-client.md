---
"@payfanout/adapter-payzen": patch
---

Map the CB network acquirer codes as the server adapter does: 03 and 30 are `invalid_request`; 20, 68, 90, 91, 96, 97, 98 and 99 `processing_error`; 15 `invalid_card_data`; and 81 `authentication_required`. An acquirer or authentication refusal is never marked retryable. ACQ_999 and AUTH_999, PayZen's technical errors, are a retryable `psp_unavailable` instead of a decline or `authentication_required`.
