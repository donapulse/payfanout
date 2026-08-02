import type { AdapterOnboardingDescriptor } from "@payfanout/core";

/**
 * Declarative onboarding metadata for the Adyen adapter pair: the credentials a
 * host collects, the provider event codes a host subscribes its standard webhook
 * to, and the CSP hosts Adyen Web touches. The credential keys mirror
 * `AdyenServerAdapterConfig` plus the client adapter's `clientKey`. The event
 * list is exactly what `webhook.ts` maps, so a host's subscription screen and the
 * parser cannot drift.
 */
export const adyenOnboarding: AdapterOnboardingDescriptor = {
  pspName: "adyen",
  credentialFields: [
    {
      key: "apiKey",
      kind: "secret",
      scope: "server",
      format: { hint: "Checkout API key (sent as X-API-Key)" },
    },
    {
      key: "merchantAccount",
      kind: "public",
      scope: "server",
      format: { hint: "Merchant account name every request is booked against" },
    },
    {
      key: "hmacKey",
      kind: "secret",
      scope: "server",
      format: { pattern: "^[0-9a-fA-F]+$", hint: "Webhook HMAC key generated in the Customer Area (hex)" },
    },
    {
      key: "webhookUsername",
      kind: "public",
      scope: "server",
      format: { hint: "Basic-auth username configured on the Adyen webhook endpoint" },
    },
    {
      key: "webhookPassword",
      kind: "secret",
      scope: "server",
      format: { hint: "Basic-auth password configured on the Adyen webhook endpoint" },
    },
    {
      key: "sessionSigningKey",
      kind: "secret",
      scope: "server",
      format: { hint: "Host-generated HMAC key that signs the stateless session context" },
    },
    {
      key: "liveUrlPrefix",
      kind: "public",
      scope: "server",
      required: false,
      format: { hint: "The account's live URL prefix — required on live only" },
    },
    {
      key: "clientKey",
      kind: "public",
      scope: "client",
      format: { pattern: "^(test|live)_", hint: "Browser-safe client key; its origins are allowlisted in the Customer Area" },
    },
  ],
  webhook: {
    signature: "hmac-sha256-base64",
    events: [
      "AUTHORISATION",
      "CANCELLATION",
      "CANCEL_OR_REFUND",
      "CAPTURE",
      "CAPTURE_FAILED",
      "REFUND",
      "REFUND_FAILED",
      "REFUNDED_REVERSED",
      "EXPIRE",
      "OFFER_CLOSED",
      "CHARGEBACK",
      "CHARGEBACK_REVERSED",
      "NOTIFICATION_OF_CHARGEBACK",
      "SECOND_CHARGEBACK",
    ],
  },
  csp: {
    // Adyen's published guidance is the wildcard: the SDK loads from the
    // checkoutshopper CDN, but 3-D Secure and wallet frames are served from
    // several other adyen.com hosts.
    script: ["https://*.adyen.com"],
    frame: ["https://*.adyen.com"],
    connect: ["https://*.adyen.com"],
  },
};
