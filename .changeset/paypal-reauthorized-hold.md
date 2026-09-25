---
"@payfanout/adapter-paypal-server": patch
---

Capture, void and report a manual-capture payment against its newest authorization, so a reauthorization made through PayPal is honoured: the original authorization no longer receives captures or voids once PayPal has replaced it.
