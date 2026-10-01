---
"@payfanout/adapter-paysafe-server": patch
---

Send an `unscheduled` `chargeSavedPaymentMethod` with `storedCredential.type` `TOPUP`, Paysafe's unscheduled merchant-initiated type, instead of `ADHOC`, which Paysafe defines as consumer-initiated.
