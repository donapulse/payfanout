---
"@payfanout/adapter-worldline-server": major
---

Send a session's `metadata` to Worldline as `order.references.merchantParameters` and report it back on `PaymentInfo.metadata`, and read it from a webhook's payment with the new `readWorldlineWebhookMetadata`. `PaymentInfo.createdAt` now comes from the payment's `transactionDate`, when that carries a time zone, instead of a 1970 placeholder.

Breaking: session `metadata` was previously ignored; it now reaches Worldline, whose API contract says the field must not contain any personal data, and comes back on `PaymentInfo`, which the server-completion route returns to the browser. Session creation also refuses, with a non-retryable `invalid_request`, metadata with a non-string value or whose JSON exceeds 1000 characters. Before upgrading, remove personal data and anything the customer should not see from Worldline session metadata, and keep it within that limit.
