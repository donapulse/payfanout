---
"@payfanout/core": major
---

Add the PSP-native subscription contract. `ServerPaymentAdapter` gains four optional methods — `listNativeSubscriptions` (cursor/limit paging), `retrieveNativeSubscription`, `createNativeSubscription` (server-only, against an already-vaulted instrument), and `cancelNativeSubscription` (verified-idempotent: an already-terminal subscription resolves as success) — operating on a unified `NativeSubscriptionRecord` with integer minor-unit amounts and a normalized status union (`pending | trialing | active | past_due | paused | canceled | completed | unknown`; unmappable provider states become `"unknown"`, never dropped).

BREAKING CHANGE: `AdapterCapabilities` now requires a `nativeSubscriptions` block declaring each operation separately (`{ list, retrieve, create, cancel }`) — provider support is uneven, so one boolean would either fake or hide support. Adapters without a native subscription product declare all-false; `validateAdapterCapabilities` reports a missing block and checks each declared operation against its implemented method. Custom adapters must add the block to `getCapabilities()`.
