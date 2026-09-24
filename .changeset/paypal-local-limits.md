---
"@payfanout/adapter-paypal-server": patch
---

The PayPal server adapter now refuses with `invalid_request`, before calling PayPal, a zero amount on sessions, updates, captures and refunds (PayPal requires more than zero), a session `id` longer than the 255 characters PayPal keeps as `custom_id`, and, at construction, a `brandName` outside 1–127 characters. `fetchEvents` accepts as a cursor only the events-list path it hands out.
