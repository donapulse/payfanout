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
await subs.chargeDueSubscriptions();   // renews, replays unanswered charges, retries (24h/72h dunning), cancels when exhausted

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
skips paused records and dunning stops (`nextRetryAt` is cleared; `failedAttempts`, any
`pendingRenewal` and any `renewalAttempt` survive — an unresolved renewal still resolves via
`resolvePendingRenewal`, but a paused record is never re-charged).
`resumeSubscription(id, { idempotencyKey })` reactivates: still paid through → just
`"active"` again, no charge; lapsed → one immediate charge re-anchors the billing cycle at
the resume instant. A failed resume charge leaves the record paused with `lastError` (no
dunning) and throws; retry with the same key so the PSP replays instead of re-charging.
A record paused over a renewal charge that never got a definitive answer cannot resume until
you settle that charge (see [below](#renewals-without-a-definitive-answer)): it may already
have paid the period.
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
  ...(renewalKey ? { idempotencyKey: renewalKey } : {}), // the charge's key, read as shown below
});
```

Resolving is replay-safe for re-delivered webhooks: a re-delivered success is a no-op, and so
is a re-delivered failure that names the charge's key. An event that settles nothing, such as
a failure without its key or an event that arrives once a later charge has collected, is
refused with `invalid_request`: log it, as the handler below does. A pending renewal that
you never resolve stays frozen — the safe default is to not charge twice, never to assume.

### Renewals without a definitive answer

Some failed charges do not say whether money moved: the PSP was unreachable or rate
limiting, the error was unknown, the adapter marked it `outcomeUnknown`, or a first
`processing_error` came back. The manager then **pins** the attempt. `renewalAttempt.replay`
holds the idempotency key and the request exactly as sent, and later charges for the period
repeat that request under that key. Where the PSP keeps a key's result (Stripe does for a
request that began executing) the replay reads the original back instead of charging again;
where it refuses a reused key, the adapter reads the original back itself and marks what it
cannot read back `outcomeUnknown`. Nothing counts as failed meanwhile: the record goes
`past_due` and the replays follow `replayDelaysMinutes` (default 5, 30, 120, 360 and 720
minutes). Each uncertain answer emits `subscription.charge_failed` with its error, once per
answer, while `subscription.past_due` fires only when the record becomes `past_due`.

A replay dedupes only while the PSP still holds the key: Stripe lets clients retry "within
24 hours", and a key reused after it is pruned starts a new request. So replays go out only
within `replayWindowHours` of the first send (default 24). Once the schedule is spent, or
the next replay would fall outside the window, the charge is **frozen**: the cron sends
nothing more for the period, emits `subscription.charge_pending`, and waits for
`resolvePendingRenewal`, as it does for a renewal on async rails. Stripe answers a `500`
with the same cached `500` for as long as it keeps the key and may still complete the
charge afterwards, notifying you by webhook, so such a charge usually ends frozen and is
settled from that webhook.

A definitive answer settles the pin. A success pays the period. A decline, an
authentication demand or a request error, unless marked `outcomeUnknown`, is a failed
attempt for dunning and moves on to a new attempt number; a second `processing_error` for
the same request counts as that attempt's own failure. Attempt numbers are never reused, so
a card set with `updateSubscription` is charged under a key the period has not used, but
only after the pinned charge of the old card has been replayed, because it may already have
paid the period. If that replay is declined, the new card is charged on the next run, and
the old card's decline does not count against it. Plan and metadata changes wait for the
pin in the same way, and a subscription set to cancel at period end replays the pin before
it ends: a charge that went through moves the period end.

Every renewal charge carries its key in its metadata as `payfanout_renewal_key` (next to
`payfanout_subscription_id`), so a payment webhook names the attempt it belongs to. A PSP
that stores no metadata carries the key elsewhere: on Paysafe the charge's `merchantRefNum`
is the key itself, `retrievePayment` returns it as `PaymentInfo.id`, and
`parseRenewalIdempotencyKey` reads the subscription id back from it. One webhook handler
then settles both kinds, pinned charges by their key and pending ones by their payment id:

```ts
import { parseRenewalIdempotencyKey } from "@payfanout/server";

// in your payment.succeeded / payment.failed webhook handler:
if ((event.type === "payment.succeeded" || event.type === "payment.failed") && event.pspPaymentId) {
  const info = await payments.retrievePayment(event.pspName, event.pspPaymentId);
  // Metadata where the PSP keeps it (Stripe); otherwise the key the PSP echoes (Paysafe).
  const echoed = parseRenewalIdempotencyKey(info.id);
  const subscriptionId = info.metadata?.payfanout_subscription_id ?? echoed?.subscriptionId;
  const renewalKey = info.metadata?.payfanout_renewal_key ?? (echoed ? info.id : undefined);
  if (subscriptionId) {
    await subs.resolvePendingRenewal(subscriptionId, {
      status: event.type === "payment.succeeded" ? "succeeded" : "failed",
      pspPaymentId: info.pspPaymentId, // becomes lastPaymentId, taken on trust
      ...(renewalKey ? { idempotencyKey: renewalKey } : {}),
    }); // an event that settles nothing is refused with invalid_request: log it
  }
}
```

Settling with the key is what ties an outcome to the pinned charge: a failure that names an
earlier attempt's key is a no-op, and a key that matches no attempt is refused. A settled
failure counts for dunning like any declined attempt. A canceled subscription keeps its
pin, and a paused one cannot resume until the pin is settled, so a charge that may have
gone through never drops out of sight.

On Stripe, a renewal that a release before pins charged but never recorded is sent again
after the upgrade under its key, now with `payfanout_renewal_key` in its metadata. Within
the 24 hours Stripe keeps the key, it refuses the changed parameters with
`idempotency_error`, marked `outcomeUnknown`, so no money moves twice and the pin ends
frozen. The original payment carries no `payfanout_renewal_key` for a webhook to settle the
pin with: find it in Stripe by its `payfanout_subscription_id` and call
`resolvePendingRenewal` with its payment id and the pinned key.

::: warning Persist `renewalAttempt` before upgrading
`renewalAttempt` is money-safety state, like `pendingRenewal`: stores must persist it
verbatim. After saving a pin the manager reads the record back, and when the pin did not
survive, it counts that failure for dunning at once: nothing is replayed under the same key,
and the retry follows `retryDelaysHours` under the next attempt number, a new key, as in
releases before pins. A charge whose answer was lost can then be charged twice. Such a store
also loses the period's attempt numbers when the card changes, since the change resets
`failedAttempts`: the new card goes out under the number that gives, which the period may
already have used, and a PSP still holding that key refuses it.
:::

### Scaling the cron: `listDue`

By default `chargeDueSubscriptions` scans every active/trialing/past_due record. Implement
the optional `SubscriptionStore.listDue({ dueBefore, limit })` to push the due-ness
predicate into your database index instead: return records with
`currentPeriodEnd <= dueBefore` (active/trialing) or `nextRetryAt <= dueBefore`
(past_due), never canceled or paused ones, in a stable order, at most `limit`. Leave out
the records only `resolvePendingRenewal` moves on: those with a `pendingRenewal`, or whose
`renewalAttempt` for the current period holds a `frozen` replay. The cron does nothing for
them, and a full batch of them would hold back every due record after it. The manager
pages until a short batch and still re-checks due-ness per record — the store filter is an
optimization, not a trust boundary.

### Concurrency & delivery semantics

Overlapping `chargeDueSubscriptions` runs that send the same renewal converge on one PSP
charge: renewal idempotency keys are deterministic per (subscription, period, attempt).
They are at-least-once for **events**: dedupe `onEvent` deliveries on
`(subscription.id, type, currentPeriodEnd)` — never on `occurredAt`, which is stamped from
the manager clock per delivery — if exactly-once matters, or hold a lock around the cron
call. `updateSubscription` and the `cancelSubscription({ atPeriodEnd: true })` flag-set
emit `subscription.updated`; renewals never do. A storage failure after a successful
charge never enters dunning: the run reports it under `ChargeDueResult.errors` and the
next run replays the same attempt key, which the PSP answers from cache instead of
charging again. An answer that reaches the store after an overlapping run has already
collected the period, or settled the attempt, is dropped. A card or plan change while a
renewal charge is in flight can make an overlapping run send another request under the
same key. The PSP holds whichever request reached it first, so the answer to a request
other than the pinned one is dropped too, and the pin is marked `contested`: from then on
a failure may be the PSP refusing the other request, so it freezes the pin, which waits for
`resolvePendingRenewal`, while a success still settles it. A refusal that comes back before
any pin exists pins the charge instead of moving it to a new key, because the adapter
leaves its outcome open: Stripe answers a request that conflicts with one still executing
with a `409`, reported as `psp_unavailable`, and a key reused with other parameters with
`idempotency_error`, marked `outcomeUnknown`; the Paysafe adapter marks its refusal of a
key whose payment may have moved money `outcomeUnknown` as well. Two cases remain outside this: a
store that drops `renewalAttempt` (see the warning above), and two requests under one key
that both reach Paysafe before either is filed, since Paysafe does not document whether its
duplicate check covers a payment still in flight. A lock around the cron call rules out the
second.

::: info Where PSP-native billing fits
This engine bills from **your** cron with identical behavior on every vaulting-capable
PSP. Providers that ship their own billing product are reachable too — see
[PSP-native subscriptions](/guide/native-subscriptions) for the normalized
list/retrieve/create/cancel surface and the adoption flow that migrates merchants from
PSP-native billing onto this engine.
:::

::: warning Storage is the host's job
There is no persistence layer of any kind. Saved-card tokens and subscription records live
in **your** database; the `SubscriptionStore` seam and the customer/token mapping are the
host's responsibility. See `docs/future-designs.md` for the vaulting/subscription design and
its scope decision.
:::
