---
"@payfanout/server": minor
---

`PaymentRouter` and `PaymentService` now pre-screen candidates by the currencies a payment method declares. A PSP whose requested rail cannot settle the session's currency is skipped before any PSP call, so the cascade continues to a PSP that can serve it instead of aborting on that PSP's own rejection. The skip reason distinguishes a rail the PSP does not offer from one it offers in other currencies.
