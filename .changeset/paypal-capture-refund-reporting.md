---
"@payfanout/adapter-paypal-server": patch
---

`capturePayment` without an amount now captures the uncaptured remainder of a PayPal authorization and closes the authorization, instead of asking PayPal for the full authorized amount again, and capturing or cancelling also accepts the capture id an earlier capture returned. `amountRefunded` leaves out failed and cancelled refunds, a completion repeated under a new idempotency key returns the existing capture or authorization instead of failing, refund reason codes are no longer sent to the payer as `note_to_payer`, and Venmo-funded orders report `paymentMethodDetails.wallet: "venmo"`.
