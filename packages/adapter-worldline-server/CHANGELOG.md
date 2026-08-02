# @payfanout/adapter-worldline-server

## 1.0.0

### Major Changes

- d500d7d: Model push-only providers in the adapter contract. `AdapterCapabilities` gains three required fields — `supportsPaymentRetrieval`, `supportsRefundRetrieval` and `modificationOutcome` — `retrievePayment` becomes optional, and `PaymentService.retrievePayment` and `retrieveRefund` now reject with `unsupported_operation` when the provider exposes no such read (`retrieveRefund` previously guarded on refund support, which is a separate capability). A provider that only acknowledges captures, cancels and refunds reports `"processing"` and a `"pending"` refund instead of a terminal state it has not confirmed. Both retrieval flags are validated in both directions, so an implemented read cannot be declared absent. The adapters shipped before this release declare full payment and refund retrieval with synchronous modifications, so their behavior is unchanged. They take a major nonetheless: `getCapabilities()` is part of their public surface and now returns an object with additional required fields, and an adapter release that quietly required a new `@payfanout/core` major could leave an application resolving two copies of core.
- 8933b9f: Model what a webhook signature covers in the adapter contract. `AdapterCapabilities` gains a required `webhookSignatureScope: "raw-bytes" | "field-values"`. `"raw-bytes"` means the signature covers bytes as delivered, so any re-encoding of the signed byte range invalidates it; `"field-values"` means the provider signs selected values extracted from the payload, so a re-encoded body still verifies and fields outside the signed set arrive unauthenticated — such an adapter must authenticate the delivery channel by another means and must never present an unsigned field as trusted. `validateAdapterCapabilities` rejects an absent scope rather than letting it disable the assertion it gates. The conformance suite applies its re-serialized-body assertion under `"raw-bytes"` and inverts it under `"field-values"`, which must additionally supply a `webhook.tamperedSignedValueBody` fixture — one signed value altered, signature as delivered — and reject it; rejecting tampered content and credential-less deliveries is still required of every adapter. The adapters shipped before this release all sign raw bytes and declare `"raw-bytes"`, so their verification behavior is unchanged; they take a major because the capability object they return gained a required field.

### Patch Changes

- Updated dependencies [d500d7d]
- Updated dependencies [8933b9f]
  - @payfanout/core@4.0.0

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
