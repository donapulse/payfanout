---
"@payfanout/server": minor
---

`PaymentRouter` and `PaymentService` now pre-screen candidates by the customer countries a payment method declares, when the session states `customerCountry`. A PSP whose requested rail cannot serve the customer's country is skipped before any PSP call, and the skip reason names the country. Sessions without `customerCountry` screen exactly as before.
