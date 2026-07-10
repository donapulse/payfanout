import type { AdapterOnboardingDescriptor } from "@payfanout/core";

/**
 * Declarative onboarding metadata for the Stripe adapter pair: the credentials a
 * host collects, the provider event-type strings the webhook parser recognizes,
 * and the CSP hosts Stripe.js touches. The credential keys mirror
 * `StripeServerAdapterConfig` (plus the client-scope `publishableKey` the browser
 * SDK needs) and the event list mirrors `webhook.ts` — keep the three in step.
 */
export const stripeOnboarding: AdapterOnboardingDescriptor = {
  pspName: "stripe",
  credentialFields: [
    { key: "secretKey", kind: "secret", scope: "server", format: { pattern: "^sk_", hint: "Stripe secret key (sk_test_… / sk_live_…)" } },
    { key: "publishableKey", kind: "public", scope: "client", format: { pattern: "^pk_", hint: "Stripe publishable key for the browser (pk_test_… / pk_live_…)" } },
    { key: "webhookSigningSecret", kind: "secret", scope: "server", format: { pattern: "^whsec_", hint: "Signing secret from the webhook endpoint" } },
  ],
  webhook: {
    signature: "hmac-sha256-hex",
    events: [
      "payment_intent.succeeded",
      "payment_intent.payment_failed",
      "payment_intent.requires_action",
      "payment_intent.processing",
      "payment_intent.canceled",
      "charge.refunded",
      "charge.refund.updated",
      "refund.created",
      "refund.updated",
      "refund.failed",
      "charge.dispute.created",
      "charge.dispute.closed",
    ],
  },
  csp: {
    script: ["https://js.stripe.com"],
    frame: ["https://js.stripe.com", "https://hooks.stripe.com"],
    connect: ["https://api.stripe.com"],
  },
};
