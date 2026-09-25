---
"@payfanout/adapter-paysafe-server": patch
---

Mark `outcomeUnknown` on the `invalid_request` a payment, capture or refund gets when its idempotency key already holds another request's payment, settlement or refund that has not failed, since that record may be the money the call was meant to move. The subscription manager then keeps such a renewal on its key instead of charging again under a new one, and a key whose earlier records all failed still rejects without the flag.
