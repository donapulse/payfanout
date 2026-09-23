---
"@payfanout/adapter-worldline-server": patch
---

Derive webhook event ids from the event type and the payment (or refund) id, the pair Worldline documents as identical across duplicate deliveries, instead of the envelope id, which Worldline never promises to repeat. A redelivered event can no longer slip past a dedupe store keyed on `event.id`. Ids change format once after upgrading (`worldline:<type>:<payment id>`), so an event delivered both before and after the upgrade may be seen twice.
