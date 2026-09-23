---
"@payfanout/adapter-worldline": minor
---

`onChange` now reports card-form validity through the Worldline Tokenizer's validation callback, so the Pay button can be gated on `complete`; a `validationCallback` passed in `fieldOptions` still runs after it. The cardholder-name field is now shown by default, because Worldline requires the cardholder name and hides that field unless told otherwise; a `hideCardholderName` value passed in `fieldOptions` still takes precedence.
