---
"@payfanout/adapter-gocardless-server": patch
---

Report `NO_CURRENCY` instead of GBP for a billing request, payment or subscription that states no currency, or an empty or malformed one. A payment read through its billing request takes the billing request's currency when it states none of its own.
