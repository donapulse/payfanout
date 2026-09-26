---
"@payfanout/adapter-adyen-server": patch
---

Report Adyen refusal 42 (3DS Authentication Error) as a non-retryable `processing_error` instead of `authentication_required`: Adyen attributes it to the card network or the issuer, so authenticating again does not help. Refusals 4 (Acquirer Error), 21 (Not Submitted), 39 (RReq not received from DS) and 40 (Current AID is in Penalty Box) are now `processing_error` and 32 (AVS Declined) `invalid_card_data`, instead of `card_declined`.
