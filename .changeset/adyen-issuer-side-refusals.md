---
"@payfanout/adapter-adyen-server": patch
---

Report Adyen refusal 42 (3DS Authentication Error) as a non-retryable `processing_error` instead of `authentication_required`: Adyen attributes it to the card network or the issuer rather than to the shopper's authentication, and advises retrying the transaction or using another payment method. Refusals 21 (Not Submitted), 39 (RReq not received from DS), 40 (Current AID is in Penalty Box) and 4 (Acquirer Error, when it came with `resultCode` Refused) are now `processing_error`, 32 (AVS Declined) `invalid_card_data` and 22 (FRAUD-CANCELLED) `fraud_suspected`, instead of `card_declined`. `createCompletionHandler` answers the refusals now reported as `processing_error` with HTTP 502 instead of 402.
