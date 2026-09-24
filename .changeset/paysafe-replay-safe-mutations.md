---
"@payfanout/adapter-paysafe-server": patch
---

Repeated Paysafe calls can no longer charge twice or fail on a payment that went through: charges, captures, refunds and verifications carry Paysafe's duplicate check, and a call whose answer was lost (timeout, dropped connection, server error) or that Paysafe rejects as a duplicate is answered with the original, looked up by its reference, instead of being re-sent. An idempotency key reused for a different amount now rejects with `invalid_request`. The default `requestTimeoutMs` is now 60 seconds, matching Paysafe's own SDKs.
