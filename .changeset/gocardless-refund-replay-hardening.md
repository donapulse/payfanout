---
"@payfanout/adapter-gocardless-server": patch
---

Read a payment's refunds for this key's stamp before creating a refund on a payment that already has refunds, so a key GoCardless no longer honours is read back instead of refunding again; keep a rejected refund retryable while the lookup that could reveal its original is unavailable; refuse an empty idempotency key; and report a replayed session whose payment awaits the customer's approval as processing.
