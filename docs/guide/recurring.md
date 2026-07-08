# Saved cards & subscriptions

Vaulting is **PSP-side only**: PayFanout persists nothing. Your database stores the opaque
token the PSP hands back, exactly like it stores a `pspPaymentId`, never a PAN.

## Saved cards (off-session charging)

Create a customer, save the card with the customer's consent during a normal checkout, then
charge the stored token off-session, no card fields, no customer present:

```ts
const customer = await payments.createCustomer("stripe", { id: user.id, email, idempotencyKey });

// checkout with consent (<PaymentFields saveConsent> renders the checkbox — see the
// React guide; its onChange state travels to YOUR server, which sets the session flag
// only when the customer actually checked it):
//   Stripe: createPaymentSession({ ..., customer: customer.pspCustomerId, savePaymentMethod: true })
//           -> after confirmation, PaymentInfo.savedPaymentMethodToken is the stored token
//   Paysafe (tokenize-first): savePaymentMethod(psp, { pspCustomerId, clientToken }) converts the
//           client's single-use token into a permanent one, then charge it

const info = await payments.chargeSavedPaymentMethod("stripe", {
  pspCustomerId: customer.pspCustomerId,
  savedPaymentMethodToken: token,      // stored in YOUR db, opaque, never card data
  amount: 1099, currency: "USD",
  occurrence: "recurring",             // honest credential-on-file flags (initial/recurring/unscheduled)
  idempotencyKey,
});
```

`listSavedPaymentMethods` / `deleteSavedPaymentMethod` complete the lifecycle; on the
client, `useSavedPaymentMethods` wraps the endpoints you build on them for the saved-cards
UI (see [React usage](/guide/react#returning-customers)).

## Subscriptions

**Subscriptions** ride on top via `SubscriptionManager`, PayFanout supplies the billing
logic (period math with calendar-safe anchors, deterministic renewal idempotency,
retry/dunning, status transitions); the **host** supplies storage (implement
`SubscriptionStore` over your database) and a cron:

```ts
import { SubscriptionManager } from "@payfanout/server";

const subs = new SubscriptionManager({ service: payments, store: myDbStore });

await subs.createSubscription({ pspName, pspCustomerId, savedPaymentMethodToken,
  plan: { amount: 1099, currency: "USD", interval: "month" }, idempotencyKey });

// your cron, every few minutes:
await subs.chargeDueSubscriptions();   // renews, retries (24h/72h dunning), cancels when exhausted

// retrieveSubscription / listSubscriptions / updateSubscription / cancelSubscription({ atPeriodEnd })
```

Off-session charges that hit a bank's authentication demand surface as
`authentication_required`, bring the customer back on-session; the dunning schedule handles
the retries.

### Renewals on async rails

A renewal charge can resolve as `"processing"` (bank rails settle later). The manager then
**freezes** the subscription instead of guessing: the record carries a `pendingRenewal`
marker, the period does not advance, and `chargeDueSubscriptions` will not charge again
until you apply the real outcome from your payment-webhook ingress:

```ts
// in your payment.succeeded / payment.failed webhook handler:
await subs.resolvePendingRenewal(subscriptionId, {
  status: "succeeded",              // or "failed" -> enters the normal dunning schedule
  pspPaymentId: event.pspPaymentId, // guards against resolving the wrong payment
});
```

Resolving is replay-safe (a re-delivered webhook is a no-op) and a pending renewal that you
never resolve stays frozen — the safe default is to not charge twice, never to assume.

### Concurrency & delivery semantics

Concurrent `chargeDueSubscriptions` runs are safe for **money** — renewal idempotency keys
are deterministic per (subscription, period, attempt), so overlapping runs converge on one
PSP charge. They are at-least-once for **events**: dedupe `onEvent` deliveries on
`(subscription.id, type, currentPeriodEnd)` if exactly-once matters, or hold a lock around
the cron call. A storage failure after a successful charge never enters dunning: the run
reports it under `ChargeDueResult.errors` and the next run replays the same attempt key,
which the PSP answers from cache instead of charging again.

::: info Why not wrap Stripe Billing?
PSP-native billing (Stripe Billing) is deliberately not wrapped: Paysafe has no equivalent,
and this engine gives both PSPs identical behavior.
:::

::: warning Storage is the host's job
There is no persistence layer of any kind. Saved-card tokens and subscription records live
in **your** database; the `SubscriptionStore` seam and the customer/token mapping are the
host's responsibility. See `docs/future-designs.md` for the vaulting/subscription design and
its scope decision.
:::
