---
"@payfanout/adapter-payzen": minor
"@payfanout/adapter-payzen-server": minor
---

Add payment-method selection on PayZen. Sessions can restrict the offered methods with `paymentMethodTypes` (mapped onto Charge/CreatePayment's `paymentMethods` field: card, Apple Pay, PayPal — wallet enablement is a per-shop contract declared via the new `paymentMethods` config override on both adapters), and the client adapter renders the multi-method smartForm with `form: "smartform"` or `"smartform-expanded"`, where the form owns its pay buttons and `confirm()` awaits the buyer's in-form completion. The new `fetchAvailablePaymentMethods()` returns the shop's live method list via `KR.getPaymentMethods()`.
