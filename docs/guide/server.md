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

`PaymentInfo` carries receipt-grade facts once the PSP reports them:
`paymentMethodDetails` (`{ brand: "visa", last4: "4242", wallet? }`) and `mandateReference`
(SEPA/ACH/BACS mandate id, quote it to the customer).

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

Candidates that can't serve the input (no manual capture, unsupported method types…) are
skipped without a PSP call; business rejections (`invalid_request`, `card_declined`) abort
the cascade, only transient trouble (`psp_unavailable`, `rate_limited`,
`processing_error`, or `retryable` errors) fails over. `attempts` is your audit trail.

A **circuit breaker** (on by default, configurable via `circuitBreaker`) remembers
outages: after 5 consecutive transient failures a PSP is skipped without paying its
latency, half-opens after 30s for a probe, and closes on any response that proves it alive.
If *every* candidate is open, they are attempted anyway, the breaker never turns an outage
into a self-inflicted hard-down.

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
`retryable` flag, and the untouched PSP error on `raw`, never dropped.

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
