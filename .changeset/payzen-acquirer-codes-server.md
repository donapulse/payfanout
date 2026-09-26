---
"@payfanout/adapter-payzen-server": patch
---

Map the CB network codes PayZen documents for a merchant set-up, request or network failure: acquirer codes 03 and 30 are now `invalid_request`; 20, 68, 90, 91, 96, 97, 98 and 99 `processing_error`; 15 `invalid_card_data`; and 81 `authentication_required`, instead of `card_declined`. Refusals stay non-retryable.
