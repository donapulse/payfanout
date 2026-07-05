# React usage

The React bindings render PSP-hosted card fields **embedded in your UI**, your code never
touches card data. Everything is SSR-safe (adapters are never touched during SSR) and works
as client components under the Next.js App Router. SDKs load lazily: only the adapter
actually mounted downloads its script.

## Quick start

```tsx
import { PayFanoutProvider, PaymentFields, PayButton, usePayFanout } from "@payfanout/react";
import { StripeClientAdapter } from "@payfanout/adapter-stripe";
import { PaysafeClientAdapter } from "@payfanout/adapter-paysafe";

const adapters = [
  new StripeClientAdapter({ publishableKey: "pk_…", environment: "sandbox" }),
  new PaysafeClientAdapter({ apiKey: "base64-public-key", environment: "sandbox" }),
];

<PayFanoutProvider adapters={adapters} initialPsp="stripe">
  <PaymentFields
    clientSecret={session.clientSecret}
    appearance={designTokens}
    onChange={({ complete }) => setPayEnabled(complete)} // disable Pay until fields are valid
  />
  <PayButton
    onResult={(result) => …}
    onServerCompletion={(clientToken) =>
      // Only tokenize-first PSPs (Paysafe) invoke this: POST to YOUR route,
      // which calls payments.completePayment(psp, { pspSessionId, clientToken, idempotencyKey }).
      postToMyApi("/api/complete", { clientToken })
    }
  >
    Pay
  </PayButton>
</PayFanoutProvider>
```

## The two completion shapes

Stripe and Paysafe have inverted flows, and the abstraction models both as first-class,
**the UI code is identical either way**:

- **Confirm-on-client (Stripe):** server creates the PaymentIntent → client mounts with
  `clientSecret` → `confirm()` finalizes (incl. inline 3DS). The server never touches
  confirmation, and `completePayment` is rejected for such PSPs.
- **Tokenize-first (Paysafe):** the client tokenizes first (`confirm()` resolves
  `requires_confirmation` + `clientToken`), then the **server** finalizes via
  `completePayment`. `<PayButton>` branches automatically through your `onServerCompletion`
  callback.

Any future tokenize-first PSP reuses the same path (`requiresServerCompletion: true`).

::: tip Why Paysafe's "session" is a signed token
Because PayFanout is stateless, the Paysafe adapter's session is a **signed, self-contained
context**: amount/currency/merchant-account are HMAC-signed into `pspSessionId` at creation
and verified at `completePayment`, the browser round-trips the token but cannot tamper with
the amount. Every context carries an **expiry** (`sessionTtlSeconds`, default 1h) enforced
at completion.
:::

## Design-system customization (fully yours)

Four independent axes, all PSP-vocabulary passthroughs, present AND future SDK options stay
reachable without a library release:

```tsx
<PaymentFields
  clientSecret={session.clientSecret}
  appearance={tokens}                       // visual theme (Stripe Appearance API / Paysafe style map)
  locale="fr-CA"                            // the PSP's own field texts
  fieldOptions={{                           // the SDK's full UI option surface:
    layout: { type: "accordion" },          //   Stripe: layout, paymentMethodOrder,
    paymentMethodOrder: ["card", "sepa_debit"], //   fields, defaultValues, terms, wallets…
  }}
/>
```

Split-field PSPs (Paysafe) let you own the layout via slots, any grid, rows, labels:

```tsx
<PaymentFields clientSecret={secret} fieldOptions={{ fields: { cardNumber: { placeholder: "Numéro de carte" } } }}>
  <div className="my-grid">
    <div data-payfanout-field="cardNumber" />
    <div className="row">
      <div data-payfanout-field="expiryDate" />
      <div data-payfanout-field="cvv" />
    </div>
  </div>
</PaymentFields>
```

Bring your own button, `usePay()` is `<PayButton>`'s engine as a hook:

```tsx
const { pay, paying } = usePay({ onServerCompletion });
<MyDesignSystemButton loading={paying} onClick={async () => show(await pay())} />
```

Adapters keep only the keys they must own to function (Stripe: `clientSecret`; Paysafe:
environment/currency/account/mount selectors), everything else is yours.

## Redirect payment methods: the return trip

Cards stay embedded, but genuinely redirect methods (iDEAL, bank redirects) leave the page.
Mount the return-trip helper on your `returnUrl` page, it probes every registered client
adapter, resolves the outcome, and reports the same `PayResult` as `<PayButton>`:

```tsx
import { useRedirectReturn } from "@payfanout/react";
const { phase, result } = useRedirectReturn({ onResult: showOutcome });
// phase: "checking" | "none" (normal page load) | "complete"
```

Implemented for Stripe today (`payment_intent_client_secret` params → real intent status,
not the `redirect_status` hint). Paysafe redirect methods stay capability-off until an
account with them enabled lets us verify the return params.

## Next

- [Webhooks](/guide/webhooks), the server-side asynchronous truth.
- [Server usage](/guide/server), the half that creates the session this page consumes.
