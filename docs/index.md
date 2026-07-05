---
layout: home

hero:
  name: PayFanout
  text: One payment API. Many PSPs.
  tagline: A unified, stateless multi-PSP abstraction for React + TypeScript. Adapt any payment gateway behind one API and one set of embedded UI components, add the next PSP by writing an adapter, with zero changes to your application code.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Set up a PSP
      link: /guide/providers
    - theme: alt
      text: Installation
      link: /guide/installation
    - theme: alt
      text: API reference
      link: /api/

features:
  - title: One API over every PSP
    details: Application code never knows which PSP is active. Add any PSP by writing a new adapter package only, zero changes to core, zero changes to your app.
  - title: Stateless by design
    details: No database, persists nothing. PayFanout orchestrates and normalizes; your app owns id mapping, webhook dedupe, and audit logs.
  - title: We never store card data
    details: Card capture lives only in the PSP's hosted, embedded card fields (SAQ-A eligible). No raw card input anywhere, saved cards are opaque PSP tokens.
  - title: Embedded, not redirected
    details: Fields render inside your UI, styled by your design tokens; 3DS/SCA runs inline. Genuinely redirect methods (iDEAL, PaysafeCard…) are modeled honestly via a flow capability.
  - title: Failover & circuit breaking
    details: PaymentRouter cascades transient failures across PSPs per currency/country, with a circuit breaker that skips known-down providers, the attempts array is your audit trail.
  - title: Proven extensible
    details: A shared conformance suite runs the identical contract against every adapter. A future adapter is done when it passes the same tests every shipped adapter passes.
---
