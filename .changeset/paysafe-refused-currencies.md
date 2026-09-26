---
"@payfanout/adapter-paysafe-server": patch
---

Refuse CLP, ISK and BYR instead of sending their amounts to Paysafe unchanged: Paysafe's currency table prices CLP and BYR with another exponent than ISO 4217 minor units (CLP 10,000 was charged as CLP 100.00) and gives none for ISK. Sessions, saved-method charges, native subscriptions, captures, voids and refunds in these currencies now reject with a non-retryable `invalid_request` before any Paysafe request, reads of such payments, refunds and subscriptions, and subscription cancels, with `unsupported_operation`, and webhook events in them carry no `amount`. Route these currencies to another provider, and manage existing payments in them in the Paysafe portal.
