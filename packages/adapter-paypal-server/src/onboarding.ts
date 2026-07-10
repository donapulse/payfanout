import type { AdapterOnboardingDescriptor } from "@payfanout/core";

/**
 * Declarative onboarding metadata for the PayPal adapter: the credentials a
 * host collects, the dashboard events its webhook parser consumes, and the CSP
 * hosts the browser SDK touches. It restates facts the adapter already embodies
 * — `PayPalServerAdapterConfig` (clientId/clientSecret/webhookId), the
 * `webhook.ts` event map, and PayPal's SDK/checkout origins — in a
 * machine-readable form so a host settings screen renders generically instead
 * of hard-coding PayPal specifics. The runtime companion is the adapter's
 * `verifyCredentials()` probe (a "Test connection" button).
 *
 * The event list MUST stay in lockstep with `webhook.ts`: every EVENT_TYPE_MAP
 * key plus CUSTOMER.DISPUTE.RESOLVED, which `mapEventType` resolves dynamically.
 */
export const paypalOnboarding: AdapterOnboardingDescriptor = {
  pspName: "paypal",
  credentialFields: [
    { key: "clientId", kind: "public", scope: "server", format: { hint: "REST app client id — public; the browser SDK needs this same value, so expose it client-side too" } },
    { key: "clientSecret", kind: "secret", scope: "server", format: { hint: "REST app secret" } },
    {
      key: "webhookId",
      kind: "public",
      scope: "server",
      required: false,
      format: { hint: "Webhook id from the dashboard listener; required for webhook verification" },
    },
  ],
  webhook: {
    // Postback verification: PayPal's own API confirms the delivery (see webhook.ts).
    signature: "provider-postback",
    events: [
      "PAYMENT.CAPTURE.COMPLETED",
      "PAYMENT.CAPTURE.PENDING",
      "PAYMENT.CAPTURE.DENIED",
      "PAYMENT.CAPTURE.DECLINED",
      "PAYMENT.CAPTURE.REFUNDED",
      "PAYMENT.CAPTURE.REVERSED",
      "PAYMENT.REFUND.FAILED",
      "PAYMENT.AUTHORIZATION.VOIDED",
      "CHECKOUT.PAYMENT-APPROVAL.REVERSED",
      "CUSTOMER.DISPUTE.CREATED",
      "CUSTOMER.DISPUTE.UPDATED",
      "CUSTOMER.DISPUTE.RESOLVED",
    ],
  },
  csp: {
    script: ["https://www.paypal.com", "https://*.paypal.com", "https://*.paypalobjects.com"],
    frame: ["https://*.paypal.com"],
    connect: ["https://*.paypal.com"],
  },
};
