---
"@payfanout/adapter-paysafe": patch
---

Map Paysafe.js 9003 failures that name a setup/tokenize `options.*` parameter (accountId, currencyCode, merchantRefNum, …) to `invalid_request` instead of `invalid_card_data`. A merchant-configuration error no longer tells the cardholder their card is invalid — so hosts alert on configuration instead of shoppers retyping a valid card — while genuine invalid card fields still surface as `invalid_card_data`.
