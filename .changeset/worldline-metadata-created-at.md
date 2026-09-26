---
"@payfanout/adapter-worldline-server": minor
---

Send a session's `metadata` to Worldline as `order.references.merchantParameters` and report it back on `PaymentInfo.metadata`, and read it from a webhook's payment with the new `readWorldlineWebhookMetadata`. Session creation refuses metadata with a value that is not a string or whose JSON exceeds Worldline's 1000-character limit, and Worldline forbids personal data in this field, so keep it out of session metadata. `PaymentInfo.createdAt` now comes from the payment's `transactionDate` instead of a 1970 placeholder.
