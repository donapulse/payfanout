---
"@payfanout/react": minor
---

Complete the React half of vaulting and async rails. `useSavedPaymentMethods` drives a returning-customer UI over host-injected fetchers (list/remove with refresh-from-source semantics, never local splicing); `<PaymentFields>` gains the `saveConsent` slot — an accessible, unchecked-by-default "save my card" checkbox whose state the host reads to set `savePaymentMethod` server-side; `usePaymentStatus` polls an async-rail payment to a terminal state with capped exponential backoff, stopping on `succeeded`/`failed`/`canceled`, on unmount, or when disabled.
