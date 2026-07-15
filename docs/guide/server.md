# Server usage

Everything server-side goes through `PaymentService`, built over a registry of adapters.
Amounts crossing this boundary are **always integer minor units**.

## Quick start

```ts
import { PaymentService, createAdapterWebhookHandler } from "@payfanout/server";
import { StripeServerAdapter } from "@payfanout/adapter-stripe-server";
import { PaysafeServerAdapter } from "@payfanout/adapter-paysafe-server";

const stripe = new StripeServerAdapter({
  secretKey: process.env.STRIPE_SECRET_KEY!,
  apiVersion: "2024-06-20",            // pinned, required
  webhookSigningSecret: process.env.STRIPE_WEBHOOK_SECRET!,
  environment: "sandbox",
});

const paysafe = new PaysafeServerAdapter({
  username: process.env.PAYSAFE_USERNAME!,
  password: process.env.PAYSAFE_PASSWORD!,
  environment: "sandbox",
  merchantAccountResolver: (currency, country) => lookupAccount(currency, country), // per currency/country, required
  sessionSigningKey: process.env.PAYSAFE_SESSION_KEY!,   // signs the stateless session context
  webhookHmacKey: process.env.PAYSAFE_WEBHOOK_HMAC_KEY!,
});

const payments = new PaymentService({ adapters: [stripe, paysafe] });

// One unified API, PSP named per call (PayFanout keeps no id mapping, you do):
const session = await payments.createPaymentSession("stripe", {
  id: order.id,                 // your id; round-tripped via PSP metadata where supported
  amount: 1099,                 // ALWAYS integer minor units at this boundary
  currency: "USD",
  idempotencyKey: order.id,     // required on every mutating call
  // Optional checkout fields (mapped per PSP, validated locally where possible):
  statementDescriptor: "MYSHOP ORDER",   // bank-statement text
  receiptEmail: "buyer@example.com",
  shippingDetails: { name: "A. Buyer", address: { line1: "1 Way", postalCode: "10001", country: "US" } },
  sca: { challenge: "force" },           // or { exemption: "moto" }, best-effort per PSP
});
// -> session.clientSecret goes to the client
```

Cart changed before confirmation? `updatePaymentSession` amends it (Stripe: in place;
Paysafe: re-issues the signed context, **always continue with the returned session**).

Later calls in the lifecycle: `retrievePayment` · `capturePayment` · `cancelPayment` ·
`refundPayment` · `retrieveRefund` (poll `"pending"` refunds) · `verifyPaymentMethod` ·
`fetchEvents` · `listPayments` · `listRefunds` (capability-gated passthroughs).
Capture, cancel, and verify take a **required `idempotencyKey`** like every other
mutating call — under multi-capture, each partial capture is its own charge with its own
key. `PaymentInfo` reports `amountCaptured`/`amountCapturable` and echoes your `metadata`
where the PSP supports it.

`PaymentInfo` carries receipt-grade facts once the PSP reports them:
`paymentMethodDetails` (`{ brand: "visa", last4: "4242", wallet? }`) and `mandateReference`
(SEPA/ACH/BACS mandate id, quote it to the customer).

## Server completion (tokenize-first)

Tokenize-first PSPs (Paysafe, PayPal) finish on the server: the browser tokenizes, then your
backend calls `completePayment` with that `clientToken`. `createCompletionHandler` turns that
into one mountable route instead of per-surface plumbing — the client's
[`completionEndpoint`](/guide/react#built-in-completion-transport) drives it automatically.

```ts
import { createCompletionHandler } from "@payfanout/server";

const complete = createCompletionHandler({
  // Map the opaque reference the browser sent (the session's clientSecret) to
  // the tenant-scoped service + session. For tokenize-first PSPs the session
  // token IS the pspSessionId, so this is usually a lookup for pspName plus a
  // stable idempotency key.
  resolveSession: async (sessionRef) => {
    const order = await db.orderByClientSecret(sessionRef); // your storage
    return {
      service: payments,
      pspName: order.psp,
      pspSessionId: order.pspSessionId,
      idempotencyKey: `complete-${order.id}`, // stable -> a retried POST dedupes
    };
  },
  onCompleted: async (info, ctx) => {
    await db.linkPayment(ctx.sessionRef, info.pspPaymentId); // persist status/id
  },
});
```

It speaks web-standard `Request`/`Response`, so it mounts as one route wherever those are
globals (Next.js App Router, Hono, workers); Express bridges its parsed body:

```ts
// Next.js App Router / Hono / workers:
export const POST = (req: Request) => complete(req);

// Express:
app.post("/api/complete", express.json(), async (req, res) => {
  const response = await complete(
    new Request("http://host/api/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req.body),
    }),
  );
  res.status(response.status).type("application/json").send(await response.text());
});
```

The wire contract (`{ sessionRef, clientToken, billingDetails? }` → `PaymentInfo`) is owned
and versioned by the library. Failures map to HTTP status by taxonomy — card declines are
`402`, an expired session token `410`, and so on (`completionErrorStatus` is the full table) —
and the client rebuilds the `PayFanoutError` from the body so `code`/`message`/`retryable`
survive. The route needs **no CSRF cookie**: the session reference is the credential, so
exempt it from first-party CSRF the way every embedded/iframe checkout must. Confirm-on-client
PSPs (Stripe) never reach this route — completion happens in the browser.

## Routing & failover

`PaymentRouter` picks the PSP per payment and cascades transient failures, **session
creation only**; every later call stays pinned to the PSP that won.

```ts
import { PaymentRouter } from "@payfanout/server";

const router = new PaymentRouter({
  service: payments,
  rules: [
    { when: { currency: ["CAD"] }, use: ["paysafe", "stripe"] },  // primary, then failover
    { when: { currency: ["EUR", "GBP"] }, use: ["stripe"] },
  ],
});
const { session, pspName, attempts } = await router.createPaymentSession(input);
```

Candidates that can't serve the input (no manual capture, no vaulting for a
`savePaymentMethod` session, no zero-amount verification, unsupported method types, a
currency the PSP or the requested rail itself cannot settle — SEPA asked for in GBP…) are
skipped without a PSP call —
the router and `PaymentService` share one predicate, `screenSessionInput` from
`@payfanout/core`, so a skipped candidate is exactly one the service would have rejected.
Business rejections (`invalid_request`, `card_declined`) abort the cascade, only transient
trouble (`psp_unavailable`, `rate_limited`, `processing_error`, or `retryable` errors)
fails over. `attempts` is your audit trail. Note a vault session is inherently pinned to
the PSP that holds the customer/token, route such traffic with single-PSP rules.

A **circuit breaker** (on by default, configurable via `circuitBreaker`) remembers
outages: after 5 consecutive transient failures a PSP is skipped without paying its
latency, half-opens after 30s for a probe, and closes on any response that proves it alive.
If *every* candidate is open, they are attempted anyway, the breaker never turns an outage
into a self-inflicted hard-down. For dashboards, `getBreakerState()` snapshots the breaker
per PSP (`consecutiveFailures`, `open`, `openUntil`) and `onBreakerStateChange` fires on
open/close transitions, exception-isolated like `onAttempt`; note a custom `shouldFailover`
also redefines what the breaker counts as transient.

## Retries, the machinery behind `retryable`

Idempotency keys are mandatory on every mutating call, so transient failures are safe to
replay. Three layers act on that:

- the **Stripe SDK** retries network failures itself (`maxNetworkRetries`, default 2);
- the **Paysafe transport** retries timeouts/5xx/429 with backoff (`maxNetworkRetries`,
  default 2, business errors like declines or `3406` are never replayed);
- `withRetry(fn, policy)` from `@payfanout/core` wraps any call with exponential backoff +
  jitter for `PayFanoutError.retryable` rejections.

## Errors, amounts, refund state

Every failure from every adapter is a `PayFanoutError` (a real `Error` subclass): unified
`code` (`card_declined`, `insufficient_funds`, `rate_limited`, …), user-safe `message`, a
`retryable` flag, and the untouched PSP error on `raw`, never dropped. Capability guards
reject with `unsupported_operation`; an expired stateless session token is
`session_expired` (create a fresh session to recover); `authentication_required` is never
retryable — bring the customer back on-session.

Amounts are **integer minor units, always**, and minor units are currency-dependent, JPY
has 0 decimals (`¥500` → `500`), BHD has 3 (`BD 1.234` → `1234`). Use
`toMinorUnits(major, currency)` / `formatMinorUnits(minor, currency)` from
`@payfanout/core`. Refund state is **derived**, never a payment status:
`getRefundState(info)` → `"none" | "partial" | "full"`.

## Observability

```ts
const payments = new PaymentService({ adapters, telemetry });
```

`telemetry` is called after every adapter operation with
`{ pspName, operation, durationMs, ok, errorCode? }`, metadata only, no amounts/ids/PII,
and a throwing hook never affects the payment path. For logging raw PSP payloads safely,
`scrubForLogging(raw)` from `@payfanout/core` deep-redacts PII/card/token fields and masks
card-number-shaped strings. Localize user-facing error text by code via
`registerErrorMessages(locale, catalog)` + `localizeError(err, locale)`.

## Payment-method verification vs. no-vaulting

Zero-amount verification on Stripe uses a SetupIntent, which *attaches a saved
PaymentMethod*, colliding with the no-storage constraint. PayFanout resolves this
explicitly: the Stripe adapter **detaches the PaymentMethod on every path** (success,
failed verification, or error) and surfaces a loud `processing_error` if the detach itself
fails. Prefer capability-off instead? Set `verifyPaymentMethodStrategy: "disabled"`.
Paysafe verification uses its Verifications API with the tokenized handle, nothing stored
either way.

## Next

- [React usage](/guide/react), the client half of the flow.
- [Webhooks](/guide/webhooks), the asynchronous truth about every payment.
- [Saved cards & subscriptions](/guide/recurring), off-session charging + billing engine.
