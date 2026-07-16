# Future designs — the big bets, decided but deliberately not built

> Naming note: nothing here refers to a package's semver — packages version independently
> and "v1" elsewhere in the docs means feature scope, not a release number. "Current scope"
> below means what the library enforces today; "future" means a later deliberate expansion
> of that scope.

The pre-2026-07-04 roadmap's strategic items each got a decision in the 2026-07-04
sessions. Three have now SHIPPED (smart routing, then — by explicit user decision later
the same day — vaulting and the recurring/subscription engine); the sections below are
kept as the historical design record, with "SHIPPED" markers pointing at the
implementation. One bet (marketplace) remains parked. docs/decisions.md carries the
shipped details.

## 1. Smart routing / failover — SHIPPED in @payfanout/server

`PaymentRouter` wraps `PaymentService`:

```ts
const router = new PaymentRouter({
  service,
  rules: [
    { when: { currency: ["CAD"] }, use: ["paysafe", "stripe"] },
    { when: { currency: ["EUR", "GBP"] }, use: ["stripe"] },
  ],
  // default chain = registration order; shouldFailover overridable
});
const { session, pspName, attempts } = await router.createPaymentSession(input);
// pin every later call to pspName; `attempts` is the audit trail of failovers
```

Design points (settled):
- **Session creation only.** A session lives on exactly one PSP; "mid-payment failover"
  is a new attempt the host initiates. Post-session calls go through `PaymentService`
  with the routed `pspName`.
- First-match-wins rules over currency / country / restricted method types; conditions
  AND, values OR. Unknown PSP names fail at construction, not at checkout.
- Capability pre-screening (manual capture, zero-amount verification, method support)
  skips candidates without burning a PSP round-trip.
- Cascade only on transient trouble (`retryable`, `psp_unavailable`, `rate_limited`,
  `processing_error`). Business rejections abort — retrying an invalid request against
  a second PSP produces surprise duplicate sessions, not resilience.
- Future extension: cost-based routing needs a fee model per PSP × method ×
  region — model it as a pluggable `score(candidate, input)` so the rules stay static
  and auditable.

## 2. Saved cards / vaulting / one-click — SHIPPED 2026-07-04 (see decisions.md)

The invariant this repealed (pre-2026-07-04, conformance-enforced at the time):
`supportsSavedPaymentMethods` was required to be `false`; `PaymentService` refused
adapters that enabled it. Shipping vaulting meant **consciously repealing that
invariant**, which is why it could not ship as a side effect — it took the explicit
2026-07-04 decision. Both shipped adapters now set the flag `true` and implement the
full surface below.

Architecture as shipped (the invariant now deliberately repealed):
- **PSP-side tokens only, PayFanout stays stateless.** Stripe: Customer +
  attached PaymentMethod (SetupIntent with `usage: "off_session"`). Paysafe:
  Customer Vault (profiles + payment handles with `usage: "MULTI_USE"`).
- New contract surface (all optional, capability-gated):
  `createCustomer`, `savePaymentMethod(customerToken, sessionToken)`,
  `listSavedPaymentMethods(customerToken)`, `deleteSavedPaymentMethod`,
  plus `CreatePaymentSessionInput.savedPaymentMethodToken` for one-click charges.
- **The host owns the mapping** `hostUserId → { pspName → pspCustomerToken }` — same
  statelessness rule as payment ids today. PayFanout never persists the vault index.
- Consent is a UX requirement, not an API flag: `<PaymentFields>` gains an opt-in
  "save this card" checkbox slot; adapters must never save without the explicit input.
- Conformance additions: saving without consent input must throw; deleting must be
  verifiable via `listSavedPaymentMethods`; a saved-method charge must work with the
  card fields never mounted.

## 3. Recurring payments / subscriptions — SHIPPED 2026-07-04 as SubscriptionManager (host-owned storage; still no PayFanout persistence)

Original decision (later repealed the same day — see the SHIPPED marker above and
decisions.md): **PayFanout will not grow a billing engine.** A scheduler is a stateful
product (dunning, proration, invoices, timezones) and PayFanout is a stateless
integration library — the mismatch is structural. What reversed it: `SubscriptionManager`
supplies the billing *logic* while all storage stays host-owned (the `SubscriptionStore`
seam), so PayFanout still persists nothing.

What ships instead, once vaulting (above) exists:
- **Merchant-scheduled charges:** the host runs its own scheduler and calls
  `createPaymentSession` with `savedPaymentMethodToken` + `offSession: true`
  (maps to Stripe `off_session: true` / Paysafe stored-credential fields). PayFanout's
  job stays: normalize SCA/decline semantics for off-session charges
  (`authentication_required` → bring the customer back on-session).
- **PSP-native subscriptions are out of scope** (Stripe Billing exists, Paysafe has no
  equivalent — an abstraction over one PSP is not an abstraction). If a host wants
  Stripe Billing it should use Stripe Billing directly; PayFanout's `raw` passthrough and
  `getAdapter()` escape hatch already allow it without forking.

## 4. Marketplace / split payments — parked, direction documented

Stripe Connect-style transfers/application fees have no Paysafe counterpart with the
same semantics (Paysafe splitpay exists but differs in onboarding, liability, and
timing). A credible unified abstraction needs: connected-account onboarding flows,
KYC state surfacing, split definitions on session creation, and reversal semantics —
each a product decision. **Parked for future discovery**; nothing in the current contract
blocks it (a `splits?: []` field on `CreatePaymentSessionInput` plus capability flag is
the expected seam).

## Smaller deliberate deferrals (with their unblock conditions)

- **Paysafe redirect/voucher methods end-to-end + wallets:** the client contract
  (`handleRedirectReturn`) and React return-trip helper shipped and work for Stripe
  redirect methods today. The Paysafe side needs the account to have Skrill/Neteller/
  PaysafeCard/wallets **enabled** (this sandbox account is CARD+CAD only) — building
  the return-trip against guessed parameter names is exactly the doc-drift trap the
  README warns about. Unblock: an enabled account, then verify the return params and
  handle-lookup flow, then flip the capability entries to `supported: true`.
- **Express wallet buttons (Apple Pay / Google Pay standalone):** Stripe wallets are
  reachable today inside the Payment Element via `fieldOptions.wallets`; a dedicated
  express-checkout surface (buttons above the fields) needs a NEW client-adapter
  contract method + capability flag — a deliberate contract change requiring its own
  sign-off, not a side effect. The seam is reserved: a `mountWalletButtons?` optional
  client method mirroring `mount`. Unblock: demand + a second PSP with an express
  surface to keep the abstraction honest.
- **Dispute/chargeback management:** today the library surfaces `payment.chargeback` webhooks;
  evidence submission stays in PSP dashboards. Unblock: real merchant demand.
- **Niche until demanded** (unchanged): Level 2/3 card data, DCC, surcharging,
  per-adapter health checks, incremental authorization (Stripe supports it only on
  select processors; Paysafe reauth semantics unverified).
