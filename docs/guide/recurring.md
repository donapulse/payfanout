# Saved cards & subscriptions

Vaulting is **PSP-side only**: PayFanout persists nothing. Your database stores the opaque
token the PSP hands back, exactly like it stores a `pspPaymentId`, never a PAN.

## Saved cards (off-session charging)

Create a customer, save the card with the customer's consent during a normal checkout, then
charge the stored token off-session, no card fields, no customer present:

```ts
const customer = await payments.createCustomer("stripe", { id: user.id, email, idempotencyKey });

// checkout with consent (the "save my card" checkbox is YOUR UI):
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

`listSavedPaymentMethods` / `deleteSavedPaymentMethod` complete the lifecycle.

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
// pauseSubscription / resumeSubscription({ idempotencyKey })
```

Monthly/yearly records remember their creation day as `anchorDay`: a subscription created
Jan 31 bills Feb 28, Mar 31, Apr 30 — the February clamp never erodes the anchor. Records
created before `anchorDay` existed keep the old clamp-forward behavior.

Off-session charges that hit a bank's authentication demand surface as
`authentication_required`, bring the customer back on-session; the dunning schedule handles
the retries.

### Trials & delayed starts

A future `startAt` creates the record as `"trialing"`: nothing is charged until the cron
crosses `startAt`, and the first successful charge flips it to `"active"`. Because that
first charge is deferred, the trial path validates eagerly — the psp must be registered
and support saved payment methods, or `createSubscription` throws before anything
persists.

### Pause & resume

`pauseSubscription(id)` (from active, trialing, or past_due) halts everything: the cron
skips paused records and dunning stops (`nextRetryAt` is cleared; `failedAttempts` and any
`pendingRenewal` survive — an unresolved renewal still resolves via
`resolvePendingRenewal`, but a paused record is never re-charged).
`resumeSubscription(id, { idempotencyKey })` reactivates: still paid through → just
`"active"` again, no charge; lapsed → one immediate charge re-anchors the billing cycle at
the resume instant. A failed resume charge leaves the record paused with `lastError` (no
dunning) and throws; retry with the same key so the PSP replays instead of re-charging.
Events: `subscription.paused` / `subscription.resumed`.

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

### Scaling the cron: `listDue`

By default `chargeDueSubscriptions` scans every active/trialing/past_due record. Implement
the optional `SubscriptionStore.listDue({ dueBefore, limit })` to push the due-ness
predicate into your database index instead: return records with
`currentPeriodEnd <= dueBefore` (active/trialing) or `nextRetryAt <= dueBefore`
(past_due), never canceled or paused ones, in a stable order, at most `limit`. The manager
pages until a short batch and still re-checks due-ness per record — the store filter is an
optimization, not a trust boundary.

### Concurrency & delivery semantics

Concurrent `chargeDueSubscriptions` runs are safe for **money** — renewal idempotency keys
are deterministic per (subscription, period, attempt), so overlapping runs converge on one
PSP charge. They are at-least-once for **events**: dedupe `onEvent` deliveries on
`(subscription.id, type, currentPeriodEnd)` — never on `occurredAt`, which is stamped from
the manager clock per delivery — if exactly-once matters, or hold a lock around the cron
call. `updateSubscription` and the `cancelSubscription({ atPeriodEnd: true })` flag-set
emit `subscription.updated`; renewals never do. A storage failure after a successful
charge never enters dunning: the run reports it under `ChargeDueResult.errors` and the
next run replays the same attempt key, which the PSP answers from cache instead of
charging again.

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
