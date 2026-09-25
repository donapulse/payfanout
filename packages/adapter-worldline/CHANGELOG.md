# @payfanout/adapter-worldline

## 1.0.2

### Patch Changes

- Updated dependencies [1d66371]
  - @payfanout/core@4.2.0

## 1.0.1

### Patch Changes

- Updated dependencies [c0e5e1f]
- Updated dependencies [9eb0ce9]
- Updated dependencies [165bb56]
  - @payfanout/core@4.1.0

## 1.0.0

### Major Changes

- 9c6e4cf: Breaking: `confirm()` now resolves a JSON `clientToken` that carries the browser data Worldline needs for 3-D Secure along with the `hostedTokenizationId`, instead of the bare `hostedTokenizationId`. Only the matching `@payfanout/adapter-worldline-server` major release decodes it, so upgrade the server adapter first: an earlier server adapter would send the whole envelope to Worldline as the `hostedTokenizationId`. The card is also tokenized without being stored at Worldline for later use.

### Minor Changes

- d8047ee: `onChange` now reports card-form validity through the Worldline Tokenizer's validation callback, so the Pay button can be gated on `complete`; a `validationCallback` passed in `fieldOptions` still runs after it. The cardholder-name field is now shown by default, because Worldline requires the cardholder name and hides that field unless told otherwise; a `hideCardholderName` value passed in `fieldOptions` still takes precedence.

## 0.1.2

### Patch Changes

- Updated dependencies [d500d7d]
- Updated dependencies [8933b9f]
  - @payfanout/core@4.0.0

## 0.1.1

### Patch Changes

- Updated dependencies [eed2987]
  - @payfanout/core@3.0.0

## 0.1.0

### Minor Changes

- cf89882: Add Worldline Direct adapter (`@payfanout/adapter-worldline`, `@payfanout/adapter-worldline-server`): Hosted Tokenization Page card payments with manual capture (a partial capture settles that amount and releases the remainder) and refunds. The server adapter is edge-runtime compatible (WebCrypto v1HMAC request signing, no Node builtins) and verifies Worldline webhook signatures.

### Patch Changes

- Updated dependencies [80b9bb6]
- Updated dependencies [d1d42fa]
  - @payfanout/core@2.0.0
