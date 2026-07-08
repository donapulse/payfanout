# @payfanout/adapter-gocardless

Client-side GoCardless adapter for [PayFanout](https://donapulse.github.io/payfanout/):
one-off bank payments via the GoCardless-hosted authorisation flow (redirect), behind the
same UI contract as every other PSP.

> **No secrets, no server code, no card fields.** There is no client-side key at all —
> the session's `clientSecret` (the hosted `authorisation_url`) carries everything.

It implements the `ClientPaymentAdapter` contract from `@payfanout/core` and plugs into
`@payfanout/react`. GoCardless permits bank authorisation only on its own hosted pages,
so this adapter renders a small informational panel instead of payment fields, and
`confirm()` redirects the payer to the hosted flow (a genuine `flow: "redirect"` method —
never faked as embedded).

📖 **Documentation:** <https://donapulse.github.io/payfanout/>
· [React usage](https://donapulse.github.io/payfanout/guide/react)
· [Set up GoCardless](https://donapulse.github.io/payfanout/guide/gocardless)

## Installation

```bash
pnpm add @payfanout/react @payfanout/adapter-gocardless react react-dom
```

## Usage

```tsx
import { PayFanoutProvider, PaymentFields, PayButton } from "@payfanout/react";
import { GoCardlessClientAdapter } from "@payfanout/adapter-gocardless";

const gocardless = new GoCardlessClientAdapter({ environment: "sandbox" }); // never inferred

<PayFanoutProvider adapters={[gocardless]} initialPsp="gocardless">
  <PaymentFields clientSecret={session.clientSecret} />
  <PayButton onResult={(result) => …}>Pay by bank</PayButton>
</PayFanoutProvider>
```

Clicking Pay redirects to the GoCardless-hosted flow; the payer authorises at their bank
and lands back on the session's `returnUrl`.

## The return trip

On the `returnUrl` page, `useRedirectReturn` (from `@payfanout/react`) probes this
adapter's `handleRedirectReturn`, which resolves **`processing`** — GoCardless is explicit
that the redirect must never decide the outcome. Confirm server-side with
`retrievePayment(billing_request_id)` or via webhooks (batched — see the
[server adapter](../adapter-gocardless-server)'s README).

## Customization

- `fieldOptions.description` — replaces the informational panel's text.
- `appearance.panel` — inline CSS properties for the panel. The authorisation UI itself
  is GoCardless-hosted and not themeable from the client.

## What's inside

- **`GoCardlessClientAdapter`** — mount (informational panel), confirm (redirect),
  `handleRedirectReturn`, and honest `flow: "redirect"` capabilities.

Pair it on the server with [`@payfanout/adapter-gocardless-server`](../adapter-gocardless-server),
which creates the billing request + hosted flow this adapter redirects to.

## Documentation

- [React usage](https://donapulse.github.io/payfanout/guide/react)
- [Set up GoCardless](https://donapulse.github.io/payfanout/guide/gocardless)
- [API reference](https://donapulse.github.io/payfanout/api/)

## License

MIT
