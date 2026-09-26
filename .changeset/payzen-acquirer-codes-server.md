---
"@payfanout/adapter-payzen-server": patch
---

Map the acquirer codes that every acquirer table PayZen documents reads the same way: 15 is now `invalid_card_data`, and 20, 68, 90, 91, 96, 97 and 99 `processing_error`, instead of `card_declined`, both on an ACQ_001 refusal and on a refund that `refundPayment` sees refused with PSP_101. A refund refused with a code read as `authentication_required` now rejects as `card_declined`. Refusals stay non-retryable.
