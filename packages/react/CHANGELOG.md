# @payfanout/react

## 0.2.1

### Patch Changes

- cbb52de: Remove the stale "not yet published to npm" notice from the package README. The package has been available on the public npm registry since its first release.
- Updated dependencies [cbb52de]
  - @payfanout/core@1.0.1

## 0.2.0

### Minor Changes

- c01317b: Complete the React half of vaulting and async rails. `useSavedPaymentMethods` drives a returning-customer UI over host-injected fetchers (list/remove with refresh-from-source semantics, never local splicing); `<PaymentFields>` gains the `saveConsent` slot — an accessible, unchecked-by-default "save my card" checkbox whose state the host reads to set `savePaymentMethod` server-side; `usePaymentStatus` polls an async-rail payment to a terminal state with capped exponential backoff, stopping on `succeeded`/`failed`/`canceled`, on unmount, or when disabled.

### Patch Changes

- c9e96b1: Fix race conditions around mounting, paying, and redirect returns. `useRedirectReturn` no longer hangs forever under React StrictMode and a cancelled probe can never fire the server-completion callback; hosted fields no longer unmount and wipe typed card data when the host re-renders with an inline `adapters` array (the mount now keys on the adapter instance); concurrent `pay()` calls share a single in-flight confirm and return the same promise instead of a fake `"processing"` result; a second mounted `<PaymentFields>` is rejected with a clear error instead of silently stealing the first one's mount slot. `usePayFanout()` results are memoized, `initialPsp` is validated eagerly, and `<PayButton>` sets `aria-busy` while a payment is in flight.
- Updated dependencies [d68ccbb]
- Updated dependencies [d2c4702]
- Updated dependencies [43569f4]
- Updated dependencies [a016891]
  - @payfanout/core@1.0.0

## 0.1.1

### Patch Changes

- Updated dependencies [6e039c2]
  - @payfanout/core@0.2.0
