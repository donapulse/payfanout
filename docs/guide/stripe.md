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

::: warning Not on npm yet
The packages are `0.1.0` and unpublished, so `pnpm add @payfanout/…` will not resolve today,
consume from source per [Installation](/guide/installation#using-it-now-from-source). The
commands above are what install looks like once a release is cut.
:::

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
| `maxNetworkRetries` | - | `2` | Network-level retries inside the Stripe SDK, safe because every mutating call carries an idempotency key. |

Every mutating call takes an integer **minor-unit** `amount` and a required
`idempotencyKey`, see [Server usage](/guide/server) for the full lifecycle.

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
Stripe.js loads from `https://js.stripe.com/v3`, and card fields render in an iframe from
Stripe. If you set a CSP, allow `script-src https://js.stripe.com` and
`frame-src https://js.stripe.com`. Pin or self-host the script via the `sdkUrl` config
field if you must.
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
| `4000 0025 0000 3155` | Requires authentication (3DS challenge, inline) |

The full matrix (per-brand, per-decline-code, wallet, and dispute-trigger cards) is at
[docs.stripe.com/testing](https://docs.stripe.com/testing).

## 8. Go live

Nothing in your PayFanout code changes except credentials and one string:

- [ ] Switch the Dashboard to **live mode** and swap in the **live** keys (`sk_live_…`,
      `pk_live_…`) via your production secrets.
- [ ] Set `environment: "live"` on **both** the server and client adapters.
- [ ] Add a **live** webhook endpoint in the Dashboard and use its **new** `whsec_…` signing
      secret (test and live endpoints have different secrets).
- [ ] Set a `statementDescriptor` on your sessions so the charge is recognizable on the
      buyer's statement.
- [ ] Confirm your card fields are still the Stripe-hosted Payment Element (SAQ-A), there
      is no raw card input anywhere.
- [ ] Keep the `apiVersion` pinned; upgrade it deliberately, not implicitly.

Then continue with [Server usage](/guide/server), [React usage](/guide/react), and
[Webhooks](/guide/webhooks).
