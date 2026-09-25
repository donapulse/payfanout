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

Replaying the same `idempotencyKey` returns the original session instead of creating a
second payment; see [Replays and idempotency keys](#replays-and-idempotency-keys).

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

### Replays and idempotency keys

GoCardless honours an `Idempotency-Key` on creates for at least 30 days; after that, a
replay under the same key may be treated as a new request. A key it has already used
answers `409 idempotent_creation_conflict` with the id of the resource it created, and
the adapter returns that resource. GoCardless documents no comparison of the new
request with the original, so the adapter makes one: a key reused for a different
payment or refund rejects with `invalid_request`.

- **Sessions.** A replayed `createPaymentSession` returns the same billing request, and
  its amount, currency and session `id` must match the new input. The session reports
  the status of the payment the billing request created, as `retrievePayment` does, or
  the billing request's own status while there is no payment yet. One exception: a
  payment awaiting the customer's approval (`pending_customer_approval`) reads
  `processing` on a replay, where `retrievePayment` reports `requires_action`, because a
  replayed session whose billing request has a payment carries no `clientSecret`. While
  the billing request is `pending` the payer gets a fresh `clientSecret`: GoCardless does
  not deduplicate flow creates, flows cannot be read back, and every flow authorises the
  one billing request. Once the payer has authorised, or the billing request is fulfilled
  or cancelled, the replay creates no flow and carries no `clientSecret`, so the payer is
  never sent to authorise the same payment twice.
- **Refunds.** A replayed `refundPayment` returns the original refund, which must belong
  to the same payment and, when you pass an `amount`, be for that amount. Every refund
  the adapter creates carries the SHA-256 of its idempotency key in its GoCardless
  metadata, as `payfanout_key_sha256` next to `reason`, so a replay is recognised from
  the refund itself. A request larger than what is left to refund, such as the replay of
  a refund that used up the payment, is never sent: the adapter reads the payment's
  refunds, returns the one stamped with the key, and otherwise rejects with
  `invalid_request`, whose `raw` carries the payment as `raw.payment` and, when the
  read was refused, GoCardless's answer as `raw.lookup`. When GoCardless rejects a refund, the same read decides whether it
  was a replay. While GoCardless reports an amount already refunded on the payment
  (`amount_refunded` above 0), the adapter also makes that read before it creates a
  refund, so a key GoCardless no longer honours is still read back instead of refunding
  again. GoCardless lets accounts opt out of the `total_amount_confirmation` check, so
  the adapter does not rely on it, nor on whether GoCardless checks the key before the
  rest of the request. This holds for every refund that carries the stamp. Refunds
  created by adapter versions before the stamp carry none, and a replay of one that
  exceeds what is left rejects with `invalid_request`, as it did then. The stamp
  and `reason` take two of the three metadata keys GoCardless allows on a refund, leaving
  one for you; if you update a refund's metadata yourself, keep `payfanout_key_sha256`.
  Use random idempotency keys; GoCardless suggests UUIDv4 ("any non-repeating unique
  identifier is sufficient"). Each refund stores the SHA-256 of its key.

  When GoCardless cannot answer the read of the payment's refunds (a timeout, a network
  or server error, rate limiting), whether before a create, after GoCardless rejected
  one, or for a request larger than what is left, `refundPayment` sends nothing further
  and rejects with a retryable `psp_unavailable` (`rate_limited` when GoCardless
  rate-limits it). After a failed create, GoCardless's answer to it is on
  `raw.rejection` and the read's own on `raw.lookup`. Retry with the same key: a new key
  can refund twice. If the read fails for any other reason, the error is marked
  `outcomeUnknown`, since whether the key already refunded stays open. Before a create,
  the refund is not sent and the call rejects with a final `invalid_request`, whatever
  the key, until the read works again: check the payment's refunds in the GoCardless
  dashboard, then retry with the same key. After a rejected create, GoCardless's
  rejection stands; retry that refund only with the same key.
  On an account that opted out of the confirmation check, make refunds of one payment
  one at a time, and wait until `retrievePayment` shows the previous refund in
  `amountRefunded`: two refunds under different keys that read the same
  `amount_refunded` can both be sent, refunding more than you intended, and GoCardless
  does not document how soon it counts a new refund there.
- **Cancels.** GoCardless documents idempotency keys for creates only, and documents
  `cancellation_failed` for cancelling a payment that is already cancelled. What it
  answers for a billing request that is already cancelled is not documented. When a
  cancel is refused, `cancelPayment` re-reads the payment or billing request and
  resolves `canceled` if it is already cancelled. Any other state rejects with the
  original error.

Use a fresh key for every new payment or refund, including the session you create
after cancelling one.

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

Until the billing request has created its payment, `retrievePayment(billing_request_id)`
reports the billing request itself: `requires_action` while it is `pending`, `processing`
once it is `ready_to_fulfil`, `fulfilling` or `fulfilled` (every action GoCardless requires
is done and the payment is being created, so never send the payer back to authorise), and
`canceled` once it is `cancelled`. Once the payment exists, it reports the payment.

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
`paid_out` is just the merchant payout and maps to `unknown`), `payments.failed` →
`payment.failed` **even after a success**: banks can report a failure late, after
`confirmed` or `paid_out`. The later `late_failure_settled` only records the failed
amount being debited from a payout, so it maps to `unknown` and a late failure is one
`payment.failed`, not two. A late failure is not always final: with Success+ GoCardless
may retry the payment, which arrives as `resubmission_requested` → `payment.processing`.
`charged_back` → `payment.chargeback`, `chargeback_cancelled` →
`payment.chargeback_won`.

Billing request events: `billing_requests.fulfilled` → `payment.processing` when the
event's `links.payment_request_payment` names the payment the billing request created
(the payer completed the hosted flow); a fulfilment naming no payment, such as a
mandate-only billing request, maps to `unknown`. `billing_requests.cancelled` →
`payment.canceled`, as `retrievePayment` reports that billing request. Every other billing
request action maps to `unknown`, `bank_authorisation_denied` included: the payer can
return to the flow and authorise again. Billing request events other than a fulfilment
carry the billing request id (`BRQ…`) as `pspPaymentId`, which `retrievePayment`
accepts. GoCardless sends every event in your account to the endpoint, so these can name
billing requests you never created (Drop-in mandate setups, payment links, templates) —
a cancelled mandate-only request arrives as `payment.canceled` too. Match `BRQ…` ids
against the sessions you created and ignore the rest, and filter on the event type before
re-reading anything.

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
`pending` until the money moves — poll `retrieveRefund` to a terminal state. A refund
larger than what is left rejects with `invalid_request` without reaching GoCardless,
unless it replays a refund the adapter stamped with the same key, which is then
returned (see [Replays and idempotency keys](#replays-and-idempotency-keys)). An
`amount` of 0 rejects the same way.

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
  the session (`cancelPayment` with the `BRQ…` id) and create a new one under a new
  idempotency key.

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
