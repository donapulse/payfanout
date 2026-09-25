---
"@payfanout/server": patch
---

On a store that drops `lastError` as well as `renewalAttempt`, a renewal without a definitive answer now counts for dunning at once instead of being replayed under its key without end. On a store that drops `renewalAttempt`, the failure of a card replaced while its charge was in flight no longer counts against the new card, which is sent on the next run under the attempt number `failedAttempts` gives: the period may already have used that number, and a provider still holding its key refuses the new card. A pinned renewal request is no longer taken for another request when a store drops or adds an empty `metadata` or `billingDetails` object.
