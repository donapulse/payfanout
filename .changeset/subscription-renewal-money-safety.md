---
"@payfanout/server": minor
---

Harden subscription renewals against double charges and unconfirmed money. A bookkeeping failure after a successful renewal charge no longer enters dunning (which would re-charge under a fresh idempotency key) — it surfaces in the new `ChargeDueResult.errors` and the next run replays the same attempt key. Renewal charges that resolve as `"processing"` now freeze the subscription with a `pendingRenewal` marker until `resolvePendingRenewal` applies the real outcome from your webhook ingress; charges that resolve as failed enter dunning instead of being recorded as paid. A cancellation racing an in-flight renewal is no longer resurrected, and one subscription's storage failure no longer abandons the rest of the cron run.
