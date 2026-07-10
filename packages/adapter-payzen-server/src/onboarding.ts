import type { AdapterOnboardingDescriptor } from "@payfanout/core";

/**
 * Declarative onboarding metadata for the PayZen adapter pair: the credentials a
 * host collects, the webhook signature scheme, and the CSP hosts the krypton
 * form touches. The server credential keys mirror `PayZenServerAdapterConfig`
 * (plus the client-scope `publicKey` the browser form needs). `webhook.events`
 * is deliberately omitted: PayZen IPNs are order-state snapshots, not discrete
 * subscribable event types, so there is no event list to render.
 */
export const payzenOnboarding: AdapterOnboardingDescriptor = {
  pspName: "payzen",
  credentialFields: [
    { key: "shopId", kind: "public", scope: "server", format: { hint: "Back Office User / numeric shop id (HTTP Basic-auth username)" } },
    { key: "password", kind: "secret", scope: "server", format: { hint: "REST API password for the environment (testpassword_… / prodpassword_…)" } },
    { key: "hmacKey", kind: "secret", scope: "server", required: false, format: { hint: "HMAC-SHA-256 key that signs browser-return kr-answers" } },
    { key: "publicKey", kind: "public", scope: "client", format: { hint: "Back Office public key, format shopId:testpublickey_…" } },
  ],
  webhook: {
    // Local HMAC-SHA-256 over the raw kr-answer, hex digest (kr-hash header).
    // No `events`: PayZen IPNs carry an order-state snapshot, not a subscribable
    // event type, so there is nothing to render as an "events to subscribe" list.
    signature: "hmac-sha256-hex",
  },
  csp: {
    script: ["https://static.payzen.eu"],
    frame: ["https://static.payzen.eu"],
    connect: ["https://api.payzen.eu", "https://static.payzen.eu"],
  },
};
