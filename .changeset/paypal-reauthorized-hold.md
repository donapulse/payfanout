---
"@payfanout/adapter-paypal-server": patch
---

Capture and report a manual-capture payment against its newest authorization, so a reauthorization made through PayPal is honoured, while `cancelPayment` still voids the original authorization, as PayPal requires. Capturing the rest, and `amountCapturable`, never exceed what the order has left, even when the reauthorization holds the full amount again, and a capture PayPal ties to no authorization counts only against the authorizations that existed when it was taken. When what is left can only be estimated, the capture keeps the authorization open rather than closing it.
