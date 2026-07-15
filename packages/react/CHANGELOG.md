# @payfanout/react

## 0.3.1

### Patch Changes

- Updated dependencies [80b9bb6]
- Updated dependencies [d1d42fa]
  - @payfanout/core@2.0.0

## 0.3.0

### Minor Changes

- 3fce22f: Add a built-in server-completion transport for tokenize-first PSPs (Paysafe, PayPal).
  `@payfanout/server` gains `createCompletionHandler`, a web-standard `Request`→`Response`
  route that finalizes a payment from `{ sessionRef, clientToken, billingDetails? }` and maps
  the error taxonomy to HTTP status. `@payfanout/react`'s `<PayFanoutProvider>` gains a
  `completionEndpoint` prop so `usePay`/`<PayButton>` derive `onServerCompletion`
  automatically, posting the session's `clientSecret` as the reference — no per-surface wiring
  or host-minted id. The explicit `onServerCompletion` callback remains as the escape hatch.

### Patch Changes

- Updated dependencies [3be57b0]
  - @payfanout/core@1.2.0

## 0.2.3

### Patch Changes

- 5999f19: Translate a small cross-PSP appearance token set (`colorPrimary`, `colorText`, `colorDanger`, `colorBackground`, `fontFamily`, `fontSize`) in the hosted-card-field adapters, Stripe and Paysafe, so one `<PaymentFields appearance>` styles either of them. Stripe maps the tokens into its Appearance API `variables`; Paysafe maps the ones its hosted inputs support onto the field `input` selector. PSP-native shapes still pass through for power users, and the Paysafe adapter now warns about appearance entries it cannot apply — e.g. a Stripe `variables` object handed to Paysafe — instead of silently dropping all styling with a cryptic "Invalid css property" from Paysafe.js. Other PSPs (PayPal button, GoCardless panel, PayZen) keep their own native `appearance` shape; the common tokens do not apply to them.
- Updated dependencies [66095d1]
  - @payfanout/core@1.1.0

## 0.2.2

### Patch Changes

- b190438: Remove the stale "not yet published to npm" notice from the package README. The package has been available on the public npm registry since its first release.
- Updated dependencies [b190438]
  - @payfanout/core@1.0.2

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
