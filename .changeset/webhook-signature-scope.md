---
"@payfanout/core": major
"@payfanout/conformance": major
"@payfanout/adapter-gocardless-server": minor
"@payfanout/adapter-paypal-server": minor
"@payfanout/adapter-paysafe-server": minor
"@payfanout/adapter-payzen-server": minor
"@payfanout/adapter-stripe-server": minor
"@payfanout/adapter-worldline-server": minor
---

Model what a webhook signature covers in the adapter contract. `AdapterCapabilities` gains a required `webhookSignatureScope: "raw-bytes" | "field-values"`. `"raw-bytes"` means the signature covers bytes as delivered, so any re-encoding of the signed byte range invalidates it; `"field-values"` means the provider signs selected values extracted from the payload, so a re-encoded body still verifies and fields outside the signed set arrive unauthenticated — such an adapter must authenticate the delivery channel by another means and must never present an unsigned field as trusted. `validateAdapterCapabilities` rejects an absent scope rather than letting it disable the assertion it gates. The conformance suite applies its re-serialized-body assertion under `"raw-bytes"` and inverts it under `"field-values"`, which must additionally supply a `webhook.tamperedSignedValueBody` fixture — one signed value altered, signature as delivered — and reject it; rejecting tampered content and credential-less deliveries is still required of every adapter. Every shipped adapter signs raw bytes and declares `"raw-bytes"`, so their behavior is unchanged.
