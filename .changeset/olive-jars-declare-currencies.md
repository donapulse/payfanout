---
"@payfanout/adapter-stripe": patch
"@payfanout/adapter-stripe-server": patch
"@payfanout/adapter-gocardless": patch
"@payfanout/adapter-gocardless-server": patch
"@payfanout/adapter-paysafe": patch
"@payfanout/adapter-paysafe-server": patch
---

Bank rails now declare the currency they settle in, so the router skips them for a payment they could never have completed: iDEAL and SEPA in EUR, ACH in USD, Bacs in GBP on Stripe; SEPA in EUR and Bacs in GBP on GoCardless. Previously a EUR-only rail looked available for a GBP payment and failed at the PSP.

Paysafe's Interac e-Transfer declares CAD as well, but the rail stays off by default, and `config.paymentMethods` replaces the declared defaults wholesale — so an account that opts the rail in must carry `currencies: ["CAD"]` in its own override for the router to pre-screen it. The adapter's CAD check is unchanged either way.
