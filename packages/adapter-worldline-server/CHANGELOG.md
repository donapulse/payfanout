# @payfanout/adapter-worldline-server

## 0.2.0

### Minor Changes

- eed2987: Declare the new native-subscription capability block explicitly all-false: Worldline Direct has no native subscription engine — recurring payments are credential-on-file charges the merchant initiates, which the vault surface and the host-side subscription engine already cover.

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
