---
"@payfanout/adapter-stripe": patch
"@payfanout/adapter-stripe-server": patch
"@payfanout/adapter-gocardless": patch
"@payfanout/adapter-gocardless-server": patch
"@payfanout/adapter-paysafe": patch
"@payfanout/adapter-paysafe-server": patch
---

Bank rails now declare the currency they settle in, so the router skips them for a payment they could never have completed: iDEAL and SEPA in EUR, ACH in USD, Bacs in GBP on Stripe; SEPA in EUR and Bacs in GBP on GoCardless; Interac e-Transfer in CAD on Paysafe. Previously a EUR-only rail looked available for a GBP payment and failed at the PSP.
