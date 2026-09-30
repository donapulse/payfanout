---
"@payfanout/adapter-gocardless-server": patch
---

Report `NO_CURRENCY` instead of GBP for a billing request, payment or subscription that states no currency. A payment that states none takes its billing request's currency first.
