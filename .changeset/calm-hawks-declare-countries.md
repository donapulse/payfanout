---
"@payfanout/adapter-stripe": patch
"@payfanout/adapter-stripe-server": patch
"@payfanout/adapter-gocardless": patch
"@payfanout/adapter-gocardless-server": patch
"@payfanout/adapter-paysafe": patch
"@payfanout/adapter-paysafe-server": patch
---

Country-bound rails now declare the customer countries they serve, so a session that states `customerCountry` routes past them when the customer cannot pay with them: iDEAL (NL), ACH (US) and Bacs (GB) on Stripe; Bacs (GB) on GoCardless; Interac e-Transfer (CA) on Paysafe. SEPA stays country-unrestricted on every adapter — the providers document a zone, not a country. As with the currency gates, a `config.paymentMethods` override replaces the declared defaults wholesale, so an override must carry its own `countries` for the router to pre-screen by them.
