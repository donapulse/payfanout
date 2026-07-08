---
"@payfanout/react": patch
---

Fix race conditions around mounting, paying, and redirect returns. `useRedirectReturn` no longer hangs forever under React StrictMode and a cancelled probe can never fire the server-completion callback; hosted fields no longer unmount and wipe typed card data when the host re-renders with an inline `adapters` array (the mount now keys on the adapter instance); concurrent `pay()` calls share a single in-flight confirm and return the same promise instead of a fake `"processing"` result; a second mounted `<PaymentFields>` is rejected with a clear error instead of silently stealing the first one's mount slot. `usePayFanout()` results are memoized, `initialPsp` is validated eagerly, and `<PayButton>` sets `aria-busy` while a payment is in flight.
