---
"@payfanout/adapter-gocardless-server": minor
---

Add PSP-native subscription support over the GoCardless Subscriptions API: `listNativeSubscriptions` (cursor paging), `retrieveNativeSubscription`, `createNativeSubscription`, and `cancelNativeSubscription`. A subscription charges a bank-debit mandate — pass the mandate id as `savedPaymentMethodToken`; week, month, and year cadences only (daily intervals and RRULE schedules reject), `merchantRefNum` becomes the subscription `name`, and creates dedupe through the Idempotency-Key conflict replay. Cancellation is verified-idempotent (a `cancellation_failed` rejection re-fetches and treats cancelled or finished subscriptions as success) — note GoCardless cancels future payment creation only: payments already created against the mandate still collect unless cancelled separately. `currentPeriodEnd` reports the earliest upcoming charge date.
