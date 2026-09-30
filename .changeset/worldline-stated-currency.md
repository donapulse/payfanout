---
"@payfanout/adapter-worldline-server": patch
---

Report `NO_CURRENCY` instead of passing on a malformed currency code that a payment record states, and report the session's currency for a 3-D Secure challenge whose payment states an empty or malformed one, which was refused as another session's payment. A refund of a payment that states no currency is refused with `invalid_request` before any request, instead of being sent in `XXX`.
