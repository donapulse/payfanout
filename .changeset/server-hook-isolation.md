---
"@payfanout/server": patch
---

Observability can no longer break payments: exceptions thrown by the router's `onAttempt` hook and the webhook handlers' `log` option are swallowed, matching the existing telemetry and `onEvent` behavior. Every rejection leaving `PaymentService` now carries `pspName` even when the adapter omitted it, and the error thrown after a failover cascade keeps the per-candidate audit trail under `raw.attempts`.
