# @payfanout/adapter-paypal

## 0.2.0

### Minor Changes

- 6e039c2: Add the PayPal adapter pair. `@payfanout/adapter-paypal` renders PayPal Buttons (the buyer approves in the popup, `onChange({ complete: true })` gates the host's Pay button) and `@payfanout/adapter-paypal-server` drives Orders v2 — capture and authorize flows with multi-capture, refunds, session updates, webhook verification via PayPal's postback API, and missed-event polling — on fetch + WebCrypto only, so it runs on edge runtimes. `paypal` joins the unified payment method types.

### Patch Changes

- Updated dependencies [6e039c2]
  - @payfanout/core@0.2.0
