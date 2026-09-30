---
"@payfanout/adapter-payzen-server": patch
---

Report a payment's order currency (`orderDetails.orderCurrency`), else `NO_CURRENCY`, instead of an empty string when the transaction states no currency, and `NO_CURRENCY` for a subscription that states none or a malformed one. A partial refund of a payment that states no currency anywhere is refused with `invalid_request` before any request, a full refund is sent without a currency instead of an empty one, and a subscription whose create answer states an empty currency reports the one sent.
