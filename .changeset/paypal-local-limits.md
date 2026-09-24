---
"@payfanout/adapter-paypal-server": patch
---

The PayPal server adapter now refuses with `invalid_request`, before calling PayPal, what PayPal would reject: a zero amount on sessions, updates, captures and refunds, and a session `id` longer than 255 characters (PayPal's `custom_id` limit). At construction it refuses a `brandName` longer than 127 characters or containing a line break; an empty one is still omitted. `fetchEvents` accepts as a cursor only the events-list path it hands out.
