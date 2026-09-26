---
"@payfanout/adapter-worldline-server": patch
---

Send the 3-D Secure use case Cartes Bancaires requires, `paymentProduct130SpecificInput.threeDSecure.usecase: "single-amount"`, on every card payment, whatever the card's brand. `sca: { exemption: "moto" }` now sends Worldline's mail order / telephone order channel, `transactionChannel: "MOTO"`, instead of being ignored, and keeps the 3-D Secure data unchanged; without it, payments keep Worldline's default e-commerce channel; MOTO needs an acquirer and a Worldline account that allow it, so run one MOTO payment in the sandbox first.
