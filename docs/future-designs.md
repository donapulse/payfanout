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
- **PSP-native subscriptions are out of scope** — SUPERSEDED 2026-07-17 (see
  decisions.md). The premise ("Paysafe has no equivalent — an abstraction over one PSP
  is not an abstraction") no longer held: a documentation review found a native
  subscription product on most shipped PSPs, Paysafe's Payment Scheduler included. The
  contract now carries per-operation `nativeSubscriptions` capabilities with
  list/retrieve/create/cancel adapter methods — the primitive under adopting
  PSP-billed subscriptions into the host engine. The original text, kept for the
  record: if a host wants Stripe Billing it should use Stripe Billing directly;
  PayFanout's `raw` passthrough and `getAdapter()` escape hatch already allow it
  without forking.

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
- **Client configuration handed over by the server adapter:** the Stripe client adapter
  takes `apiVersion` in its own config because nothing carries the server adapter's pin
  to the browser: a `PaymentSession` reaches the client adapter only as the `clientSecret`
  in `MountOptions` (decisions.md, "Stripe.js version follows the pinned API version"). A
  provider-data field on the session, handed to `mount()`, would let a server adapter tell
  its client half what the browser SDK needs, an API version or anything else fixed when
  the SDK loads, instead of the host setting it in two places. It changes the contract of
  core, conformance and every adapter, a major release with its own sign-off. Unblock: a
  second provider whose client half needs server-side configuration, and that sign-off.
- **A named Trusted Types policy for the SDK loader:** under `require-trusted-types-for
  'script'` core's `injectScript` assigns a plain URL, so the page's default policy must
  accept each SDK URL (decisions.md, "Trusted Types and the SDK loader"). An opt-in named
  `payfanout` policy, created only when the host allows that name in its `trusted-types`
  directive and restricted to the adapters' own SDK URLs, would let a strict page drop its
  default policy for them. It adds a policy the host must list and review, so it waits for a
  host that enforces Trusted Types without a default policy. Unblock: that host.
- **GoCardless one-off Direct Debit sessions (Bacs, SEPA Core):** a session today is a
  billing request's payment request, a one-off Open Banking payment, so the adapter declares
  `sepa_debit` and `bacs_debit` unsupported (decisions.md, "GoCardless sessions declare Pay
  by Bank only"). A Direct Debit session would be a billing request with a mandate request
  (`bacs` or `sepa_core`), fulfilled in the hosted flow, followed by a server-side
  `POST /payments` against the new mandate for the session's amount. That payment confirms
  on debit timing (days), so the session must be `requiresServerCompletion` (or the host must
  accept a payment created after the redirect), the mandate becomes a reusable handle the
  vault contract would have to expose honestly, and the payment's charge date and late
  failures need their own event mapping. Another route, for Pro and Enterprise accounts
  with custom payment pages, is the restricted
  `POST /billing_requests/{id}/actions/fallback`, which moves a billing request with
  `fallback_enabled` from Open Banking to Direct Debit. Unblock: demand for Direct Debit
  one-offs through GoCardless, a decision on how completion and the mandate surface in the
  contract, and a sandbox run of the mandate-then-payment sequence.
- **Dispute/chargeback management:** today the library surfaces `payment.chargeback` webhooks;
  evidence submission stays in PSP dashboards. Unblock: real merchant demand.
- **Niche until demanded** (unchanged): Level 2/3 card data, DCC, surcharging,
  per-adapter health checks, incremental authorization (Stripe supports it only on
  select processors; Paysafe reauth semantics unverified).
