# PSP-native subscriptions

Some providers ship their own subscription product: the **PSP** stores the schedule,
creates each installment, retries failures, and reports outcomes — Stripe Billing,
Paysafe's Payment Scheduler, GoCardless subscriptions, PayPal subscriptions, PayZen
recurrences. PayFanout exposes that surface directly, normalized across providers:

```ts
const page = await payments.listNativeSubscriptions("stripe", { limit: 50 });
const sub  = await payments.retrieveNativeSubscription("stripe", { subscriptionId });
const made = await payments.createNativeSubscription("stripe", {
  savedPaymentMethodToken: token,      // the vaulted instrument the PSP will charge
  pspCustomerId: customer.pspCustomerId,
  amount: 1099, currency: "USD",
  interval: "month",                   // or intervalCount: 3, or schedule: "FREQ=..."
  idempotencyKey,
});
const gone = await payments.cancelNativeSubscription("stripe", { subscriptionId, idempotencyKey });
```

Every record is a `NativeSubscriptionRecord`: integer minor-unit `amount`, uppercase
`currency`, a unified `status`
(`pending | trialing | active | past_due | paused | canceled | completed | unknown`),
the cadence (`interval`/`intervalCount`, or the source `schedule` RRULE when the
provider's cadence is richer), period bounds, and the vault token/customer facts needed
to re-anchor billing elsewhere. Provider states with no faithful projection normalize to
`"unknown"` — never dropped, never guessed; each adapter documents its exact mapping.

## Native vs. host-side: two engines, one rule

| | PSP-native subscriptions | [`SubscriptionManager`](/guide/recurring#subscriptions) |
| --- | --- | --- |
| Who bills | the **PSP** schedules and collects | **your host app** charges vault tokens on your cron |
| Where state lives | at the PSP | in your database (`SubscriptionStore`) |
| Behavior across PSPs | whatever each provider's product does | identical everywhere (period math, dunning, pause/resume) |
| Works on | providers with a native product, per operation | every vaulting-capable PSP |
| PayFanout persistence | none | none |

Both honor the library's one hard rule: PayFanout persists nothing. Native operations
are read/write passthroughs to the provider; the host still owns every id it wants to
remember.

## Capability is per operation

Provider support is uneven, so there is no single "supports subscriptions" flag —
`getCapabilities(psp).nativeSubscriptions` declares each operation separately and
`PaymentService` guards each passthrough on its own flag:

| PSP | list | retrieve | create | cancel | Notes |
| --- | --- | --- | --- | --- | --- |
| Stripe | yes | yes | yes | yes | Billing Subscriptions API; list returns Stripe's default (not-canceled) set |
| Paysafe | yes | yes | yes | yes | Payment Scheduler; bills a multi-use payment handle; day/month/year cadences only |
| GoCardless | yes | yes | yes | yes | bills a bank-debit mandate; week/month/year cadences only; see the cancel caveat below |
| PayPal | yes | yes | no | yes | creation needs buyer approval in the PayPal UI — a server-only create would fake support; a list page costs one call per returned item to resolve amounts |
| PayZen | no | yes | yes | yes | no list API: retain `subscriptionId` **and** `paymentMethodToken`, they are a composite key |
| Worldline | no | no | no | no | no native engine — recurring is card-on-file; use the vault + `SubscriptionManager` |

Check the flag before offering the feature in your UI; calling an undeclared operation
rejects with `unsupported_operation`.

## Creating: the cadence is exactly one thing

`createNativeSubscription` takes **either** `interval` (+ optional `intervalCount`)
**or** an RFC 5545 `schedule` — never both, never neither. Adapters map simple
intervals onto their provider's vocabulary and **reject what the provider cannot
express** (`invalid_request`) instead of approximating: a weekly cadence on a provider
without weeks, or an RRULE on a provider that only takes fixed intervals, fails loudly
at create time rather than billing on a schedule the merchant did not ask for.

Mutating calls carry the usual required `idempotencyKey`, forwarded through each
provider's idempotency channel.

## Canceling is verified-idempotent

Adapters treat an already-terminal subscription as **success**: if the provider rejects
a cancel, the adapter re-fetches and resolves normally when the subscription is already
canceled (or completed). Replaying a cancel — which adoption flows do — can never fail
on its own earlier success.

::: warning GoCardless: cancel stops future charges, not in-flight ones
Cancelling a GoCardless subscription stops **future payment creation**; payments already
created against the mandate still collect unless cancelled separately. Check
`listPayments` for in-flight charges when a same-day stop matters.
:::

## Adopting subscriptions from a PSP (migration)

The flow this surface exists for: a merchant arrives with live subscriptions inside a
PSP's billing product, and your platform must become the single biller without
double-charging anyone.

```ts
// 1. Page through the PSP's live subscriptions.
let cursor: string | undefined;
do {
  const page = await payments.listNativeSubscriptions(psp, { limit: 50, cursor });
  for (const native of page.subscriptions) {
    if (native.status !== "active" && native.status !== "trialing" && native.status !== "past_due") continue;

    // 2. Re-create it in YOUR engine against the same vaulted instrument,
    //    anchored on the period the customer has already paid for.
    await subscriptionManager.createSubscription({
      pspName: psp,
      pspCustomerId: native.pspCustomerId!,
      savedPaymentMethodToken: native.savedPaymentMethodToken!,
      plan: { amount: native.amount, currency: native.currency,
              interval: native.interval!, intervalCount: native.intervalCount },
      startAt: native.currentPeriodEnd,   // first host charge = the PSP's next-due instant
      idempotencyKey: `adopt-${native.id}`,
    });

    // 3. Stop the PSP's billing — idempotent, safe to replay on partial failures.
    await payments.cancelNativeSubscription(psp, {
      subscriptionId: native.id,
      savedPaymentMethodToken: native.savedPaymentMethodToken,
      idempotencyKey: `adopt-cancel-${native.id}`,
    });
  }
  cursor = page.nextCursor;
} while (cursor);
```

Order matters: create host-side first, cancel PSP-side second, and key both steps on the
native subscription id — a crashed run replays into the same state. Records whose
`interval` is absent carry the provider's `schedule` instead; decide per RRULE whether
your plan vocabulary can express it before adopting.

On a provider without `list` (PayZen), the merchant's export of
`subscriptionId` + `paymentMethodToken` pairs replaces step 1 — retrieve each pair and
continue identically.

## What this is not

Plan/price catalog management, proration, invoices, and pause/resume stay provider
dashboard concerns — the unified surface is deliberately the four operations adoption
and ordinary lifecycle management need. For everything richer on a single provider, the
`getAdapter()` escape hatch and `raw` passthrough still exist.
