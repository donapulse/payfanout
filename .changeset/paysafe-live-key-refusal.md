---
"@payfanout/adapter-paysafe-server": patch
---

Mark `outcomeUnknown` on the `invalid_request` a payment, capture or refund gets when its idempotency key already holds another request's payment, settlement or refund that may have moved money (one not failed, voided, cancelled or expired), since that record may be the money the call was meant to move, and on a bank-debit completion whose key holds another request's spent payment handle while no payment made with it shows. The subscription manager then keeps such a renewal on its key instead of charging again under a new one, and a key whose earlier records moved no money still rejects without the flag.
