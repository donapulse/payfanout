---
"@payfanout/adapter-paysafe-server": minor
---

Add PSP-native subscription support over the Paysafe Payment Scheduler (`subscriptionsplans/v1`), authenticated with the same API key as the Payments API: `listNativeSubscriptions` (offset paging surfaced as an opaque cursor), `retrieveNativeSubscription`, `createNativeSubscription`, and `cancelNativeSubscription`. Creation charges a multi-use payment handle token under `POST /plans/{planId}/subscriptions` — a given `planId` is fetched and validated against the input before anything is created, and without one the adapter mints an open-ended plan inline; `merchantRefNum` doubles as the idempotency channel, with replayed creates recovered by reference lookup. Cancellation PATCHes the final `CANCELLED` status and is verified-idempotent (a rejected cancel re-fetches and treats `CANCELLED`/`COMPLETED` as success). Day, month, and year cadences only — weekly intervals and RRULE schedules reject as `invalid_request`.
