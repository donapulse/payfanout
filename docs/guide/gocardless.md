# Set up GoCardless

GoCardless is a **bank payments** PSP: no cards, no card fields. PayFanout drives its
one-off payments ("Pay by Bank" / Instant Bank Pay) through **Billing Requests**: the
server creates a billing request plus a GoCardless-hosted authorisation flow, the browser
**redirects** the payer to their bank, and GoCardless fulfils the billing request itself.
That makes it **confirm-on-client** shaped (no server-completion route), with one twist
every integrator must internalize: **outcomes are asynchronous — webhooks and
`retrievePayment` are the source of truth, never the redirect.**

Two packages: [`@payfanout/adapter-gocardless-server`](/guide/server) (holds your access
token; **edge-runtime compatible**, WebCrypto only, runs on Cloudflare Workers /
Next.js edge) and [`@payfanout/adapter-gocardless`](/guide/react) (browser-safe — it holds
**no key at all**; the session's `clientSecret` is the hosted authorisation URL).

::: warning GoCardless API details evolve
Dashboard menu names, scheme availability per country, and simulator catalogs change over
time and vary per account. The **field names and behavior below are exact** (read from the
adapter source), but re-verify credential locations and scheme enablement against your own
[GoCardless developer docs](https://developer.gocardless.com) before going live.
:::

## 1. Get your GoCardless credentials

From the **GoCardless dashboard** (sandbox: `manage-sandbox.gocardless.com`) under
**Developers**:

| Credential | What it is | Used by |
| --- | --- | --- |
| **Access token** | Bearer token for the REST API — create it **read-write** (shown once) | server adapter (`accessToken`) |
| **Webhook endpoint secret** | Signs webhook deliveries; created with the endpoint | server adapter (`webhookSecret`) |

There is **no client-side key**: bank authorisation happens on GoCardless-hosted pages,
so the browser never talks to the GoCardless API.

Sandbox and live are **separate accounts and separate hosts** — the adapter derives the
host from `environment` (`sandbox → api-sandbox.gocardless.com`,
`live → api.gocardless.com`).

## 2. Install

```bash
# server
pnpm add @payfanout/server @payfanout/adapter-gocardless-server
# client (React)
pnpm add @payfanout/react @payfanout/adapter-gocardless react react-dom
```

There is no GoCardless browser SDK to load for the redirect flow — nothing extra to
`pnpm add`, nothing injected at runtime.

::: warning Not on npm yet
The packages are `0.1.0` and unpublished, consume from source per
[Installation](/guide/installation#using-it-now-from-source) until a release is cut.
:::

## 3. Environment variables

```bash
# .env (server), never committed
GOCARDLESS_ACCESS_TOKEN=…        # read-write sandbox token
GOCARDLESS_WEBHOOK_SECRET=…      # the webhook endpoint's secret
```

## 4. Wire the server adapter

```ts
import { PaymentService } from "@payfanout/server";
import { GoCardlessServerAdapter } from "@payfanout/adapter-gocardless-server";

const gocardless = new GoCardlessServerAdapter({
  accessToken: process.env.GOCARDLESS_ACCESS_TOKEN!,
  environment: "sandbox",                                // → api-sandbox.gocardless.com
  webhookSecret: process.env.GOCARDLESS_WEBHOOK_SECRET!, // string, or string[] while rotating
});

const payments = new PaymentService({ adapters: [gocardless] });
```

| Field | Required | Default | Notes |
| --- | --- | --- | --- |
| `accessToken` | ✅ | - | Read-write dashboard token. Server-only. |
| `environment` | ✅ | - | Exactly `"sandbox"` or `"live"`; selects the API host. Never inferred. |
| `webhookSecret` | ✅ | - | The endpoint's signing secret. Pass a **`string[]`** to rotate with no cutover. |
| `goCardlessVersion` | - | `2015-07-06` | Pinned `GoCardless-Version` header on every request. |
| `fallbackEnabled` | - | unset | Lets the flow fall back from instant payment to a Direct Debit mandate. Fallback payments confirm on **debit timing (days)**, not seconds. |
| `exitUri` | - | unset | Where the hosted flow sends payers who cannot proceed (e.g. unsupported bank). |
| `requestTimeoutMs` | - | `30000` | Abort a hung connection; surfaces as a retryable `psp_unavailable`. |
| `maxNetworkRetries` | - | `2` | Retries transport trouble (network/timeout/5xx/429) only, never business errors. |

`createPaymentSession` **requires `returnUrl`** (the hosted flow redirects the payer back
to it) and returns:

- `pspSessionId` — the billing request id (`BRQ…`). Store it: `retrievePayment` accepts
  it directly (and the payment id `PM…` once one exists).
- `clientSecret` — the hosted flow's `authorisation_url`, which the client adapter
  redirects to.
- `status: "requires_action"` — the payer still has to authorise at their bank.

Billing-request and refund creates carry an `Idempotency-Key`; replaying a key returns
the **original** resource rather than creating a duplicate (GoCardless answers 409
`idempotent_creation_conflict` and the adapter resolves it). GoCardless does **not**
dedupe flow creates, so a replayed session returns the same billing request with a
**fresh `clientSecret`** — either authorisation URL completes that one billing request,
no duplicate payment is possible.

Two checkout-field mappings to know:

- **`statementDescriptor` rides `payment_request.description`** — the text the payer
  sees on the **GoCardless authorisation screen**, *not* the bank statement line (the
  statement-level `reference` field is restricted to specific account setups, so the
  adapter withholds it). GoCardless requires a description, so the adapter falls back
  to `metadata.description`, then a derived `Payment <id>` default.
- **GoCardless metadata holds at most three keys**, and `payfanout_id` (your session
  `id`) claims the first slot — only the **first two** session `metadata` keys, in
  insertion order, are forwarded; later keys are withheld rather than failing the
  payment, and a host key named `payfanout_id` never overrides the session id. Without
  a session `id`, three host keys fit.

## 5. Wire the client adapter

```tsx
import { PayFanoutProvider, PaymentFields, PayButton } from "@payfanout/react";
import { GoCardlessClientAdapter } from "@payfanout/adapter-gocardless";

const gocardless = new GoCardlessClientAdapter({ environment: "sandbox" });

<PayFanoutProvider adapters={[gocardless]} initialPsp="gocardless">
  <PaymentFields clientSecret={session.clientSecret} />
  <PayButton onResult={(result) => showOutcome(result)}>Pay by bank</PayButton>
</PayFanoutProvider>
```

There are no fields to fill: `<PaymentFields>` renders a small informational panel
(override its text via `fieldOptions.description`, style it via `appearance.panel`), and
the pay button is enabled immediately. Clicking it **navigates the page** to the
GoCardless-hosted flow, where the payer picks their bank and authorises.

## 6. The redirect return trip

GoCardless sends the payer back to your `returnUrl` with `billing_request_id` (and
`billing_request_flow_id`) in the query string. Mount the return-trip helper on that page:

```tsx
import { useRedirectReturn } from "@payfanout/react";
const { phase, result } = useRedirectReturn({ onResult: showOutcome });
// GoCardless returns always resolve { status: "processing" }
```

::: danger The redirect is a signal, not an outcome
GoCardless is explicit: **"Don't use the redirect to confirm the outcome. Always use
webhooks."** `handleRedirectReturn` therefore resolves `processing`, never `succeeded`.
Follow up server-side — `retrievePayment(billing_request_id)` maps the current truth
(instant payments usually confirm within seconds; Direct Debit fallback takes days) — or
wait for the `payment.succeeded` webhook.
:::

## 7. Register the webhook endpoint — deliveries are BATCHED

Create the endpoint in Dashboard → Developers → Webhooks, point it at
`https://your-api.example/webhooks/gocardless`, and copy its secret into
`GOCARDLESS_WEBHOOK_SECRET`.

One GoCardless delivery carries **up to 250 events** in a single signed body
(`{"events": [...]}`, hex HMAC-SHA256 over the exact raw bytes in the
`Webhook-Signature` header). So GoCardless ingress differs from the other adapters:
**verify once, then fan out per event** with `parseGoCardlessWebhookEvents` — the
single-event `parseWebhookEvent` contract method throws on multi-event deliveries rather
than silently dropping events.

```ts
import { parseGoCardlessWebhookEvents } from "@payfanout/adapter-gocardless-server";

app.post("/webhooks/gocardless", express.raw({ type: "application/json" }), async (req, res) => {
  const rawBody = req.body.toString("utf8"); // exact raw bytes — express.json() would destroy them
  const headers = req.headers as Record<string, string>;
  if (!(await gocardless.verifyWebhookSignature(rawBody, headers))) {
    res.status(498).end(); // GoCardless's "Invalid Token" convention
    return;
  }
  for (const event of parseGoCardlessWebhookEvents(rawBody)) {
    await enqueue(event); // ack-fast: enqueue, dedupe by event.id; never process inline
  }
  res.status(200).end();
});
app.use(express.json()); // AFTER the webhook route
```

::: warning The shared handlers 400 on batched deliveries
`createUnifiedWebhookHandler` / `createAdapterWebhookHandler` from `@payfanout/server`
route through the single-event `parseWebhookEvent`, so any GoCardless delivery carrying
more than one event makes them respond **400** (events refused, never dropped). The
dedicated route above is the supported GoCardless ingress.
:::

Failed deliveries are retried with the same event ids — dedupe on `event.id` (the host
owns that store; PayFanout persists nothing). Event ordering is not guaranteed, within a
batch or across deliveries. For missed-webhook recovery the adapter also supports
`fetchEvents` (`supportsEventPolling: true`).

Notable mappings: `payments.confirmed` → `payment.succeeded` (money collected;
`paid_out` is just the merchant payout and maps to `unknown`), `late_failure_settled` →
`payment.failed` **after** a success (late failures are real on debit rails),
`charged_back` → `payment.chargeback`, `chargeback_cancelled` →
`payment.chargeback_won`, `billing_requests.fulfilled` → `payment.processing` (the
payer completed the hosted flow; the event's `links.payment_request_payment` is the new
payment id).

::: warning A bank-debit chargeback is effectively final
The direct debit guarantee reclaims the funds at `charged_back` itself, and GoCardless
has no merchant dispute flow — so **no GoCardless event maps to
`payment.chargeback_lost`**. Treat `payment.chargeback` as lost unless
`payment.chargeback_won` (`chargeback_cancelled`: the payer's bank withdrew the claim,
rare) follows. The later `chargeback_settled` action is payout accounting — the
already-reclaimed funds being debited from a payout — not a dispute outcome; it maps to
`unknown` like the other payout events.
:::

## 8. Refunds must be enabled first

Refunds are **disabled by default** on GoCardless accounts — a registered admin requests
them from GoCardless support. Until then, `refundPayment` rejects with an
`invalid_request` explaining exactly that (the API returns 403). Once enabled: full and
partial refunds work, the adapter computes GoCardless's required
`total_amount_confirmation` safety check from a fresh read, and refunds report
`pending` until the money moves — poll `retrieveRefund` to a terminal state.

## 9. Supported currencies & schemes

GoCardless supports **eight two-decimal currencies** (no JPY, no BHD). One-off payments
(what `createPaymentSession` creates) are **GBP and EUR only** — other currencies reject
with `invalid_request`:

| Payment | Scheme | Currency | Confirms in |
| --- | --- | --- | --- |
| One-off (this adapter's sessions) | `faster_payments` | GBP | seconds |
| One-off (this adapter's sessions) | `sepa_credit_transfer` / `sepa_instant_credit_transfer` | EUR | seconds–1 business day |
| Direct Debit fallback (`fallbackEnabled`, reported by `retrievePayment`) | `bacs` | GBP | ~3 business days |
| Direct Debit fallback (`fallbackEnabled`, reported by `retrievePayment`) | `sepa_core` | EUR | ~1–2 business days |

GoCardless the **platform** also collects USD, CAD, AUD, NZD, SEK and DKK over `ach`,
`pad`, `becs`, `becs_nz`, `autogiro`, `betalingsservice` and `pay_to` — those are
**mandate-based flows this adapter's one-off sessions cannot reach** (mandate work is
parked as future work). They are mentioned only as platform context; a PayFanout session
through this adapter is GBP or EUR, full stop.

## 10. Sandbox testing

In the hosted flow's sandbox test bank, use GoCardless's published test details:

| Scheme | Test values |
| --- | --- |
| UK (Bacs / Faster Payments) | sort code `200000`, account `55779911` |
| SEPA | IBAN `FR1420041010050500013M02606` or `DE89370400440532013000` |
| ACH | routing `026073150`, account `2715500356` |

The sandbox never submits to real banks; drive state transitions with the dashboard's
**scenario simulators** (e.g. `payment_confirmed`, `payment_failed`,
`billing_request_fulfilled`) or the name-triggered customer simulators — both emit real
webhooks. "Send test webhook" in the dashboard exercises your endpoint end to end.

## 11. Limitations (v1, by design)

- **No saved payment methods yet.** GoCardless mandates are genuinely reusable charging
  handles, but bank debits confirm asynchronously — they cannot meet the vault
  contract's instantly-succeeded off-session charge, so the adapter declares
  `supportsSavedPaymentMethods: false` honestly. Mandates-as-vault is parked as future
  work.
- **One-off payments are GBP/EUR.** Other currencies need mandate-based flows.
- **Payments confirm asynchronously.** Even instant rails report `processing` until the
  `confirmed` event; Direct Debit fallback takes days, and **late failures can flip a
  succeeded payment to failed** — build order fulfilment on webhooks, not the redirect.
- **No session updates.** A billing request's payment amount cannot be amended — cancel
  the session (`cancelPayment` with the `BRQ…` id) and create a new one.

## 12. Go live

- [ ] Create a **live** read-write access token and swap it in.
- [ ] Set `environment: "live"` on **both** adapters (host flips to `api.gocardless.com`).
- [ ] Complete GoCardless account verification (payouts require it).
- [ ] Create the **live** webhook endpoint and use its **live** secret.
- [ ] If you refund, confirm refunds are enabled on the **live** account too.
- [ ] Re-check scheme/currency enablement for your account and override
      `paymentMethods` if it differs from the defaults.

Then continue with [Server usage](/guide/server), [React usage](/guide/react), and
[Webhooks](/guide/webhooks).
