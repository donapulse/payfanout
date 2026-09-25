---
"@payfanout/adapter-paysafe-server": patch
---

Mark the errors that cannot say whether money moved `outcomeUnknown`: the retry-later endings of a replayed write, and the refusals of a key holding several records or a full lookup page. Callers and the subscription manager then retry them only under the same idempotency key.
