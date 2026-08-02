---
"@payfanout/core": major
"@payfanout/conformance": major
"@payfanout/server": major
"@payfanout/adapter-gocardless-server": minor
"@payfanout/adapter-paypal-server": minor
"@payfanout/adapter-paysafe-server": minor
"@payfanout/adapter-payzen-server": minor
"@payfanout/adapter-stripe-server": minor
"@payfanout/adapter-worldline-server": minor
---

Model push-only providers in the adapter contract. `AdapterCapabilities` gains three required fields — `supportsPaymentRetrieval`, `supportsRefundRetrieval` and `modificationOutcome` — `retrievePayment` becomes optional, and `PaymentService.retrievePayment` and `retrieveRefund` now reject with `unsupported_operation` when the provider exposes no such read (`retrieveRefund` previously guarded on refund support, which is a separate capability). A provider that only acknowledges captures, cancels and refunds reports `"processing"` and a `"pending"` refund instead of a terminal state it has not confirmed. Both retrieval flags are validated in both directions, so an implemented read cannot be declared absent. Every shipped adapter declares full payment and refund retrieval with synchronous modifications, so their behavior is unchanged.
