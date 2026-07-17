---
"@payfanout/server": minor
---

`PaymentService` gains capability-guarded passthroughs for PSP-native subscriptions: `listNativeSubscriptions`, `retrieveNativeSubscription`, `createNativeSubscription`, and `cancelNativeSubscription`, each gated on the adapter's per-operation `nativeSubscriptions` capability and rejecting undeclared operations with `unsupported_operation`. `createNativeSubscription` validates the money and cadence at the boundary — integer minor-unit amount, exactly one of `interval` (with optional `intervalCount`) or `schedule`, a parseable `startAt` — and every mutating call requires the usual `idempotencyKey`. Telemetry reports the four new operation names. The host-side `SubscriptionManager` is unchanged; the new surface is how hosts read and stop PSP-billed subscriptions, including when adopting them into the host engine.
