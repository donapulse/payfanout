# Set up Stripe

Stripe is a **confirm-on-client** PSP: your server creates a PaymentIntent, the browser
mounts Stripe's Payment Element with the returned `clientSecret`, and `confirm()` finalizes
the payment inline (including 3DS). The server never touches confirmation. This guide wires
Stripe end to end, credentials, server adapter, client adapter, webhooks, against the
**sandbox** (Stripe calls it *test mode*), then lists what changes to go live.

Two packages: [`@payfanout/adapter-stripe-server`](/guide/server) (holds your secret key)
and [`@payfanout/adapter-stripe`](/guide/react) (browser-safe, holds only the publishable
key).

## 1. Get your Stripe credentials

Everything comes from the [Stripe Dashboard](https://dashboard.stripe.com). Keep the
dashboard's **Test mode** toggle **on** while you build, test-mode keys are prefixed
`sk_test_` / `pk_test_` and move no money.

| Credential | Where | Prefix | Used by |
| --- | --- | --- | --- |
| **Secret key** | Developers → API keys → *Secret key* | `sk_test_…` / `sk_live_…` | server adapter (`secretKey`) |
| **Publishable key** | Developers → API keys → *Publishable key* | `pk_test_…` / `pk_live_…` | client adapter (`publishableKey`) |
| **Webhook signing secret** | Developers → Webhooks → *(your endpoint)* → *Signing secret* | `whsec_…` | server adapter (`webhookSigningSecret`) |

The **API version** (`apiVersion`, e.g. `2024-06-20`) is **not a credential**, you pin it
in code (see below). It is shown at Developers → API version, but never rely on the account
default: it can change under you.

::: danger Secret key is server-only
`sk_…` and `whsec_…` never leave your backend. Only the publishable key (`pk_…`) is safe in
the browser bundle. The `scripts/check-boundaries.mjs` check fails the build if the server
adapter is ever imported into client code.
:::

## 2. Install

```bash
# server
pnpm add @payfanout/server @payfanout/adapter-stripe-server
# client (React)
pnpm add @payfanout/react @payfanout/adapter-stripe react react-dom
```

The `stripe` Node SDK is bundled with the server adapter, nothing else to add. Stripe.js
is **not** an npm dependency; the client adapter injects it lazily from Stripe's CDN on
first mount.

## 3. Environment variables

```bash
# .env (server), never committed
STRIPE_SECRET_KEY=sk_test_…
STRIPE_WEBHOOK_SECRET=whsec_…

# client bundle, Vite exposes only VITE_-prefixed vars to the browser
VITE_STRIPE_PUBLISHABLE_KEY=pk_test_…
```

## 4. Wire the server adapter

```ts
import { PaymentService } from "@payfanout/server";
import { StripeServerAdapter } from "@payfanout/adapter-stripe-server";

const stripe = new StripeServerAdapter({
  secretKey: process.env.STRIPE_SECRET_KEY!,               // sk_test_… / sk_live_…
  apiVersion: "2024-06-20",                                 // REQUIRED, pinned, no default
  webhookSigningSecret: process.env.STRIPE_WEBHOOK_SECRET!, // string, or string[] while rotating
  environment: "sandbox",                                   // "sandbox" | "live", never inferred
});

const payments = new PaymentService({ adapters: [stripe] });
```

| Field | Required | Default | Notes |
| --- | --- | --- | --- |
| `secretKey` | ✅ | - | `sk_test_…` / `sk_live_…`. Constructor throws if empty. |
| `apiVersion` | ✅ | - | Pin it (e.g. `"2024-06-20"`). **No default**, the constructor throws without it. Must be a version the bundled `stripe` SDK supports. |
| `webhookSigningSecret` | ✅ | - | `whsec_…`. Pass a **`string[]`** to rotate with no cutover, any secret that verifies wins. |
| `environment` | ✅ | - | Exactly `"sandbox"` or `"live"`. Never inferred from the `sk_test`/`sk_live` prefix. |
| `verifyPaymentMethodStrategy` | - | `"setup_intent_detach"` | Zero-amount verification attaches a PaymentMethod, so the default **detaches it on every path** to honor no-vaulting. Set `"disabled"` to turn the capability off entirely. |
| `webhookToleranceSeconds` | - | `300` | Replay-protection window for the webhook timestamp. |
| `requestTimeoutMs` | - | SDK default (`80000`) | Abort a hung Stripe request, response body included; surfaces as a retryable `psp_unavailable`. Applies per attempt: a timeout before the response starts is retried within `maxNetworkRetries`. |
| `maxNetworkRetries` | - | `2` | Network-level retries inside the Stripe SDK, an integer ≥ 0. Calls that create objects or move money carry the caller's idempotency key, so a retry cannot duplicate them. At `0` the SDK still replays a closed connection once. |

Every mutating call takes an integer **minor-unit** `amount` and a required
`idempotencyKey`, see [Server usage](/guide/server) for the full lifecycle.

When a session restricts `paymentMethodTypes`, the adapter forwards only the
requested rails that can settle the session currency, per the same declared
per-method `currencies` gates that `getCapabilities()` exposes — Stripe rejects
a PaymentIntent whose explicit `payment_method_types` carries a
currency-incompatible entry, so `["sepa_debit", "card"]` in GBP becomes a
card-only session rather than a failed one (sandbox-verified). If **no**
requested rail can settle the currency the adapter rejects with
`invalid_request` before calling Stripe, naming the rails and the currency.
Zero-amount verification sessions are SetupIntents, which carry no currency —
they are never narrowed. An overridden `config.paymentMethods` list carries its
own gates: a rail declared without `currencies` is forwarded unnarrowed.

### Currencies with Stripe-specific units

PayFanout amounts are in the minor units `getCurrencyExponent` from `@payfanout/core` gives
each currency, which follow ISO 4217 (JPY 0, BHD 3). Stripe's
[currencies page](https://docs.stripe.com/currencies) also asks for `amount` "in the
currency's minor unit", but departs from ISO 4217 for two currencies it accepts, and the
adapter converts both, on every call that sends an amount and on every amount it reports:

| Currency | PayFanout's decimals | Stripe's `amount` | Sent to Stripe | Reported back |
| --- | --- | --- | --- | --- |
| ISK | 0 | two decimals, always `00` | × 100: ISK 1,000 (`amount: 1000`) goes out as `100000` | ÷ 100 |
| MGA | 2 | no decimals, whole ariary | ÷ 100: MGA 10.00 (`amount: 1000`) goes out as `10` | × 100 |

- An MGA amount that is not whole ariary (a multiple of 100 in PayFanout's units) cannot be
  charged at Stripe, and is refused with a non-retryable `invalid_request` before the
  request that would carry it (see below for when that refusal is marked `outcomeUnknown`).
- An ISK amount Stripe reports that is not a multiple of 100 has no value in whole krónur:
  the read meeting one rejects with `unsupported_operation`, with the record on
  `raw.record`, and a webhook event carrying one has no `amount`.
- Three-decimal amounts (BHD, JOD, KWD, OMR, TND) must still be multiples of 10 on
  `createPaymentSession`, an `updatePaymentSession` naming both amount and currency,
  `chargeSavedPaymentMethod` and `createNativeSubscription`, a rule from an earlier version
  of Stripe's currencies page that the adapter keeps where it always applied it. Captures,
  refunds, amount-only updates and the amount a currency change keeps are left to Stripe.
- Every other currency is sent and reported unchanged.

**UGX is refused.** Stripe's page lists UGX among its zero-decimal currencies and, in its
special cases, asks for UGX amounts as two-decimal values ending in `00` ("to charge 5 UGX,
provide an `amount` value of `500`"). Which unit Stripe reads a UGX amount in is therefore
unknown, and the wrong guess charges a hundred times too much or too little, so the adapter
neither sends nor reports UGX amounts:

- `createPaymentSession`, `updatePaymentSession`, `chargeSavedPaymentMethod` and
  `createNativeSubscription` in UGX reject with a non-retryable `invalid_request` before any
  request. `updatePaymentSession`, `capturePayment` and `refundPayment` that send an amount
  for a UGX payment reject the same way once they have read the payment (below).
- `retrievePayment`, `retrieveRefund` and `retrieveNativeSubscription` of a UGX record
  reject with `unsupported_operation`: read it in the Stripe Dashboard.
- A capture, cancellation or refund without an amount, an update that changes neither
  amount nor currency, and a subscription cancellation go through at Stripe even for a UGX
  record, but their answer cannot be reported: they reject with `unsupported_operation`
  marked `outcomeUnknown`. Check the record in the Stripe Dashboard before acting on it.
- `listPayments`, `listRefunds` and `listNativeSubscriptions` fail a page holding a UGX
  record, or an ISK amount that is not a multiple of 100, with `unsupported_operation`.
  `raw.records` names each such record, and `raw.nextCursor` carries the cursor the page
  would have had, so later pages stay reachable; a `limit` of 1 steps past each one.
- Webhook and `fetchEvents` events in UGX carry no `amount`; `currency` and every other
  field stay.
- A zero-amount session is a SetupIntent, which carries neither an amount nor a currency, so
  the adapter creates it in every currency, UGX included, when you call it directly.
  `PaymentService` and the router refuse it in UGX all the same (below); since a SetupIntent
  is the same in any currency, create it in another one.

**Refusals that leave the outcome open.** Earlier releases sent UGX amounts, and MGA amounts
that are not whole ariary, to Stripe unconverted, so a call retried under the same
idempotency key after the upgrade may meet money that an earlier attempt already moved. The
refusal of such an amount is therefore marked `outcomeUnknown` on:

- `chargeSavedPaymentMethod` and `createNativeSubscription`, whose earlier attempt the
  adapter cannot read back;
- `capturePayment` with an amount, unless the PaymentIntent it reads is still
  `requires_capture`, which shows nothing was captured;
- `refundPayment` with an amount, unless the PaymentIntent's refunds, which the adapter
  lists on the way to the refusal (`GET /v1/refunds`, one more request), show nothing
  moved: the list must be complete and hold only `failed` or `canceled` refunds, or none.
  A `pending` or `requires_action` refund keeps it open, and so does a list that cannot be
  read. A refund that is sent lists nothing;
- `updatePaymentSession` when the update names UGX or sends an amount for a UGX
  PaymentIntent. A currency change away from a UGX PaymentIntent, whose amount cannot be
  kept, is refused final.

Each of these refusals, final or open, asks you to check the Stripe Dashboard for a charge,
subscription, capture, refund or update under that idempotency key before sending another,
and, like any `outcomeUnknown` error, an open one may be retried only under the same key.
Every other refusal of an amount is final.

**The router skips Stripe for UGX.** The adapter declares UGX in `unsupportedCurrencies`, so
`PaymentRouter` skips a Stripe candidate for a UGX session and tries the next one in the
chain, and `PaymentService` refuses a UGX session for Stripe before calling the adapter,
zero-amount sessions included. Its refusal is a non-retryable `unsupported_operation`
(`"stripe" declares currency UGX unsupported`), where the adapter's own is `invalid_request`.
A `paymentMethods` override with a rail whose `currencies` are UGX alone now fails
registration, since that rail can never be routed. The router reads the declaration from the
`@payfanout/server` release that added `unsupportedCurrencies`.
Give UGX a chain that names a provider serving it; when no candidate does, the router fails
with `invalid_request`, each candidate's refusal on `raw`
([routing and failover](/guide/server#routing-failover)).

**Some calls read the payment first.** Stripe's units depend on the currency, so
`capturePayment` and `refundPayment` that state an amount, and `updatePaymentSession` that
carries `amount` without `currency` or `currency` without `amount`, first read the
PaymentIntent (`GET /v1/payment_intents/:id`): one more request on each such call. A
currency change without an amount keeps the session's amount in PayFanout's minor units, and
always sends it converted for the new currency, so a retry under the same key sends the same
request: a session of `amount: 1000` moved from ISK to USD asks for USD 10.00, not the
USD 1,000.00 Stripe's own `100000` would mean. Such a currency change reads the amount and
then writes it, so an amount update that lands between the two is overwritten: send the
updates of one session one at a time.

::: warning Upgrading from a release that sent these amounts unchanged
Earlier releases sent ISK and MGA amounts to Stripe as they were: ISK 1,000
(`amount: 1000`) was charged as ISK 10, and MGA 10.00 (`amount: 1000`) as MGA 1,000. Reads
now report what Stripe holds, so such a payment reads back as ISK 10 (`amount: 10`) or
MGA 1,000.00 (`amount: 100000`). Reconcile ISK and MGA payments made before the upgrade in
the Stripe Dashboard, and check the Stripe Billing subscriptions created in them, which keep
billing the price they were created with. A session created before the upgrade still charges
the amount it was created with when the customer confirms it: cancel open ISK and MGA
sessions, or re-send their amount with `updatePaymentSession`, right after upgrading.
`SubscriptionManager` renewals on Stripe in UGX, and in MGA amounts that are not whole
ariary, are now refused before they reach Stripe, marked `outcomeUnknown`, which the
manager treats as a charge
[without a definitive answer](/guide/recurring#renewals-without-a-definitive-answer): the
renewal is pinned to its key and the subscription goes `past_due`, the replays on
`replayDelaysMinutes` meet the same refusal, and the charge is then frozen until you settle
it with `resolvePendingRenewal`. Move those subscriptions to another provider before
upgrading. UGX payments and subscriptions made before the upgrade can no longer be read
through the adapter: read them in the Stripe Dashboard.
:::

## 5. Wire the client adapter

```tsx
import { PayFanoutProvider, PaymentFields, PayButton } from "@payfanout/react";
import { StripeClientAdapter } from "@payfanout/adapter-stripe";

const stripe = new StripeClientAdapter({
  publishableKey: import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY, // pk_test_… / pk_live_…
  environment: "sandbox",                                       // "sandbox" | "live"
  // returnUrl: "https://shop.example/checkout/return",         // only for redirect methods (iDEAL, bank)
});

<PayFanoutProvider adapters={[stripe]} initialPsp="stripe">
  <PaymentFields
    clientSecret={session.clientSecret}                 // from the server's createPaymentSession
    onChange={({ complete }) => setPayEnabled(complete)} // disable Pay until fields are valid
  />
  <PayButton onResult={(result) => showOutcome(result)}>Pay</PayButton>
</PayFanoutProvider>
```

- Only `publishableKey` and `environment` are required. `returnUrl` matters **only** for
  genuinely redirect methods; card payments and 3DS stay inline (Stripe's
  `redirect: "if_required"`) and never navigate away.
- **Confirm-on-client:** `<PayButton>` calls `confirm()` in the browser and resolves the
  outcome. Stripe **never** uses `onServerCompletion`, that callback is for tokenize-first
  PSPs like [Paysafe](/guide/paysafe).
- **SSR-safe:** constructing the adapter at module scope is fine; only *mounting* runs in
  the browser. Components work as Next.js App Router client components.

::: tip Content-Security-Policy
Stripe.js loads from `https://js.stripe.com/v3` and renders card fields, 3DS, and
redirect challenges in iframes. Stripe's security guide lists these sources for
Stripe.js, and for Link, which the Payment Element offers when your account enables it:

```
script-src  https://js.stripe.com https://*.js.stripe.com
frame-src   https://js.stripe.com https://*.js.stripe.com https://hooks.stripe.com
            https://link.com https://*.link.com
connect-src https://api.stripe.com https://link.com https://*.link.com
img-src     https://*.link.com
```

`https://*.js.stripe.com` lets Stripe.js start its frames on other origins to load faster.
The guide also lists `https://maps.googleapis.com`, needed only with the Address Element
and your own Google Maps key; this adapter mounts the Payment Element alone. Stripe.js
must load from `https://js.stripe.com`: Stripe asks never to bundle or self-host it, and
the script refuses to run from another origin. The `sdkUrl` config field only points the
adapter at another `https://js.stripe.com` URL, such as a versioned build.

**Nonce-based policies.** Pass the nonce your server put in the page's policy as
`cspNonce` (the adapter never reads one from the page), and the adapter sets it as the
`nonce` attribute of the Stripe.js `<script>` it injects. That matters only for a
`script-src` that allows scripts by nonce without `'strict-dynamic'`: under
`'strict-dynamic'` the script-created tag loads without one, and `https://js.stripe.com`
in `script-src` allows it anyway. Stripe.js reads no nonce itself and loads its lazy
chunks from `https://js.stripe.com` without one, so such a policy must still list that
host. Where the browser lacks constructable stylesheets, Stripe.js adds a `<style>`
without a nonce, which needs `'unsafe-inline'` in `style-src`, and a nonce in `style-src`
turns `'unsafe-inline'` off there, blocking that fallback. On a page that can mount other
PSPs as well, read
[Content-Security-Policy on a page with several PSPs](/guide/providers#content-security-policy-on-a-page-with-several-psps)
before giving a directive a nonce.
:::

## 6. Register the webhook endpoint

Webhooks are how the asynchronous truth (async declines, refunds, disputes) reaches you.

**In the Stripe Dashboard** → Developers → Webhooks → *Add endpoint*:

- **URL:** `https://your-api.example/webhooks/stripe`
- **Events:** subscribe to the `payment_intent.*`, `charge.*`, `charge.refund.*`, and
  `charge.dispute.*` families (or *all events*). PayFanout normalizes the ones it knows and
  marks the rest `type: "unknown"`, subscribing to extras is harmless.
- Copy the endpoint's **Signing secret** (`whsec_…`) into `STRIPE_WEBHOOK_SECRET`.

Mount the handler with the **raw body**, signature verification hashes the exact bytes, so
register the raw parser *before* `express.json()`:

```ts
import { createAdapterWebhookHandler } from "@payfanout/server";
const stripeHook = createAdapterWebhookHandler(stripe, {
  onEvent: (event) => enqueue(event), // ack-fast: enqueue, dedupe by event.id; never process inline
});

app.post("/webhooks/stripe", express.raw({ type: "application/json" }), async (req, res) => {
  const r = await stripeHook({ rawBody: req.body.toString("utf8"), headers: req.headers });
  res.status(r.status).end();
});
app.use(express.json()); // AFTER the webhook route
```

See [Webhooks](/guide/webhooks) for Next.js/Fastify variants, dedupe, and recovery.

::: tip Local development
Install the [Stripe CLI](https://docs.stripe.com/stripe-cli), then
`stripe listen --forward-to localhost:4242/webhooks/stripe`. It prints a `whsec_…` signing
secret, use **that** as `STRIPE_WEBHOOK_SECRET` in dev, and trigger events with
`stripe trigger payment_intent.succeeded`.
:::

## 7. Test cards

In test mode, use Stripe's test cards with any future expiry, any CVC, and any postal code.

| Card number | Outcome |
| --- | --- |
| `4242 4242 4242 4242` | Success |
| `4000 0000 0000 0002` | Declined (`card_declined`) |
| `4000 0000 0000 9995` | Declined (`insufficient_funds`) |
| `4000 0000 0000 9979` | Declined, card reported stolen (`fraud_suspected`) |
| `4000 0000 0000 0127` | Incorrect CVC (`invalid_card_data`) |
| `4000 0000 0000 0069` | Expired card (`expired_card`) |
| `4000 0025 0000 3155` | Requires authentication (3DS challenge, inline) |

The full matrix (per-brand, per-decline-code, wallet, and dispute-trigger cards) is at
[docs.stripe.com/testing](https://docs.stripe.com/testing).

## 8. Go live

Nothing in your PayFanout code changes except credentials and one string:

- [ ] Switch the Dashboard to **live mode** and swap in the **live** keys (`sk_live_…`,
      `pk_live_…`) via your production secrets.
- [ ] Set `environment: "live"` on **both** the server and client adapters.
- [ ] If you take UGX, give it a routing chain that names another provider: the router
      skips Stripe for it from the `@payfanout/server` release that reads
      `unsupportedCurrencies` (§4, "Currencies with Stripe-specific units"). With an older
      server, place a rule that sends UGX elsewhere before any rule that can send it to
      Stripe.
- [ ] Add a **live** webhook endpoint in the Dashboard and use its **new** `whsec_…` signing
      secret (test and live endpoints have different secrets).
- [ ] Set a `statementDescriptor` on your sessions so the charge is recognizable on the
      buyer's statement.
- [ ] Confirm your card fields are still the Stripe-hosted Payment Element (SAQ-A), there
      is no raw card input anywhere.
- [ ] Keep the `apiVersion` pinned; upgrade it deliberately, not implicitly.

Then continue with [Server usage](/guide/server), [React usage](/guide/react), and
[Webhooks](/guide/webhooks).
