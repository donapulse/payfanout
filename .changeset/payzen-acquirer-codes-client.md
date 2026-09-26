---
"@payfanout/adapter-payzen": patch
---

Map the acquirer codes as the server adapter does: 15 is now `invalid_card_data`, and 20, 68, 90, 91, 96, 97 and 99 `processing_error`, instead of `card_declined`, and no acquirer or authentication refusal is retryable. ACQ_999 and AUTH_999, PayZen's technical errors, are a retryable `psp_unavailable`, whether `KR.onError` reports them or an unpaid order carries them, and errors built from these answers carry the core catalog's messages.
