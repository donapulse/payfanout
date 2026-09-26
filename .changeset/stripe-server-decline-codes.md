---
"@payfanout/adapter-stripe-server": patch
---

Read the issuer's decline codes `expired_card`, the card-detail codes (such as `incorrect_cvc` or `incorrect_zip`) and `processing_error` as their error-code namesakes, as the browser adapter does, instead of reporting them as `card_declined`. A `processing_error` decline code is therefore retryable, as the error code already was, so a subscription renewal it ends is replayed once under the same key. `lost_or_stolen_card` joins the fraud decline codes.
