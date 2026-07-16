---
"@payfanout/adapter-payzen": minor
"@payfanout/adapter-payzen-server": minor
---

Add PayZen's bank rails through the hosted payment page: SEPA Direct Debit (`sepa_debit`), iDEAL (`ideal`), the pay-by-bank family — SEPA Credit Transfer via payment initiation, MyBank, Przelewy24 (`bank_redirect_generic`) — and Multibanco (`voucher_generic`). Sessions requesting a bank rail create a payment order and return the hosted page URL as `clientSecret` (`status: "requires_action"`, `returnUrl` required); the client adapter renders an informational panel, `confirm()` redirects, and the new `handleRedirectReturn` resolves the return trip while the IPN stays the source of truth. Each rail is a per-shop contract and defaults to `supported: false` in the `paymentMethods` capability declaration.
