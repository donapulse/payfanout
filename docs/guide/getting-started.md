# Getting started

**PayFanout** is a unified multi-PSP payment abstraction for React + TypeScript. You get
**one consistent API** and **one set of embedded UI components** over multiple Payment
Service Providers, your application code never knows which PSP is active. PayFanout is
**provider-agnostic**: implement any payment gateway by writing a new adapter package
only, **zero changes to core, zero changes to consuming application code**,
verified by a shared conformance suite.

::: info PayFanout is stateless. It has no database and persists nothing.
The consuming application owns:

- the mapping between its internal payment/order ids and `pspPaymentId`s,
- the webhook event dedupe store ("have I processed this event id"),
- any audit / event log.

PayFanout's job is orchestration + normalization only. If you are looking for where
PayFanout stores a payment, it doesn't. See `examples/demo/server.mts` for what the host
app is expected to keep.
:::

## Two non-negotiables baked into the design

- **We never store card data, and neither do you.** Card capture happens exclusively in
  each PSP's hosted surface (Stripe's Payment Element, Paysafe.js fields, PayZen's
  krypton form, Worldline's Hosted Tokenization iframe — all SAQ-A eligible); there
  is no raw card `<input>` anywhere. Saved cards / recurring payments change nothing about
  this: the **PSP** vaults the card and hands back an opaque token, your database stores
  that token exactly like it stores a `pspPaymentId`, never a PAN.
- **Payment flows are modeled honestly.** Embedded card fields render in your UI, styled
  by your design tokens, and 3DS/SCA challenges run inline (iframe/modal). Genuinely
  redirect/voucher payment methods (iDEAL, PaysafeCard, Skrill…) are modeled via the
  `flow` capability field, never forced into an embedded illusion.

## The packages

| Package | Runs | Purpose |
| --- | --- | --- |
| `@payfanout/core` | anywhere | Unified domain model, adapter contracts, currency + error + refund-state helpers. Zero dependencies, zero PSP code. |
| `@payfanout/server` | server | `PaymentService` over an adapter registry + framework-agnostic webhook handlers. |
| `@payfanout/react` | client | `<PayFanoutProvider>`, `usePayFanout`, `<PaymentFields>`, `<PayButton>`. |
| `@payfanout/adapter-stripe-server` | server | Stripe Node SDK: PaymentIntents, refunds, webhook verification. **Pins an explicit `apiVersion`.** |
| `@payfanout/adapter-stripe` | client | Stripe.js + Payment Element. |
| `@payfanout/adapter-paysafe-server` | server | Paysafe Payments REST API. **Edge-runtime compatible** (WebCrypto, no Node builtins). |
| `@payfanout/adapter-paysafe` | client | Paysafe.js hosted iframe fields (tokenize-first). |
| `@payfanout/conformance` | tests | The contract suite every adapter, present or future, must pass. |

Client packages have **zero** dependency on anything holding secrets; this is enforced
mechanically by `scripts/check-boundaries.mjs` (part of `pnpm run check`), not by
convention. Every adapter config requires an explicit `environment: "sandbox" | "live"`,
never inferred from key prefixes.

## Mental model in 30 seconds

1. **Server** creates a payment session through `PaymentService`, naming the PSP per call.
   Amounts are **always integer minor units** at this boundary.
2. The session's `clientSecret` (Stripe) or signed context (Paysafe) goes to the browser.
3. **React** mounts `<PaymentFields>` + `<PayButton>`, the customer pays without your code
   ever touching card data.
4. **Webhooks** arrive as one normalized `UnifiedWebhookEvent`, whichever PSP sent them.

## Next steps

- [Installation](/guide/installation), prerequisites, which packages to add, env vars.
- [Server usage](/guide/server), sessions, routing/failover, retries, observability.
- [React usage](/guide/react), provider, fields, buttons, design-system customization.
- [Webhooks](/guide/webhooks), raw-body verification, dedupe, recovery.
- [Saved cards & subscriptions](/guide/recurring), PSP-side vaulting + the billing engine.
- [API reference](/api/), the generated TypeDoc for every public symbol.

::: tip Versioning note
Packages version independently (see `.changeset/config.json`) and don't share one
library-wide release number. Where docs say "v1", read "the current feature scope", not
any package's semver.
:::
