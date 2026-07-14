import type { AdapterOnboardingDescriptor } from "@payfanout/core";

/**
 * Declarative onboarding metadata for the Worldline Direct adapter pair: the
 * credentials a host collects, the provider event-type strings the webhook
 * parser recognizes, and the CSP hosts the Hosted Tokenization iframe touches.
 * The credential keys mirror `WorldlineServerAdapterConfig` and the event list
 * mirrors `webhook.ts`'s EVENT_TYPE_MAP — keep the three in step.
 *
 * There is no client-scope credential: the Hosted Tokenization iframe is
 * addressed entirely by the `hostedTokenizationUrl` the server session returns,
 * so the browser holds no Worldline key.
 */
export const worldlineOnboarding: AdapterOnboardingDescriptor = {
  pspName: "worldline",
  credentialFields: [
    {
      key: "apiKeyId",
      kind: "public",
      scope: "server",
      format: { hint: "Worldline Direct API key id (v1HMAC key identifier)" },
    },
    {
      key: "secretApiKey",
      kind: "secret",
      scope: "server",
      format: { hint: "Worldline Direct secret API key (v1HMAC signing secret)" },
    },
    {
      key: "merchantId",
      kind: "public",
      scope: "server",
      format: { hint: "Worldline Direct merchant id (PSPID), the {merchantId} path segment" },
    },
    {
      key: "sessionSigningKey",
      kind: "secret",
      scope: "server",
      format: { hint: "Host-generated HMAC key that signs the stateless session context" },
    },
    {
      key: "webhooksKeyId",
      kind: "public",
      scope: "server",
      format: { hint: "Worldline webhook key id (matches the X-GCS-KeyId header)" },
    },
    {
      key: "webhooksSecretKey",
      kind: "secret",
      scope: "server",
      format: { hint: "Worldline webhook secret key (signs webhook payloads)" },
    },
  ],
  webhook: {
    signature: "hmac-sha256-base64",
    events: [
      "payment.created",
      "payment.redirected",
      "payment.authorization_requested",
      "payment.pending_approval",
      "payment.pending_completion",
      "payment.pending_fraud_approval",
      "payment.pending_capture",
      "payment.capture_requested",
      "payment.captured",
      "payment.paid",
      "payment.rejected",
      "payment.rejected_capture",
      "payment.cancelled",
      "payment.refunded",
      "refund.refund_requested",
      "refund.refunded",
      "refund.rejected",
      "refund.cancelled",
    ],
  },
  csp: {
    // The Hosted Tokenization script and iframe are served from the payment host
    // (preprod for sandbox, the bare host for live); XHRs go to the same origin.
    script: [
      "https://payment.preprod.direct.worldline-solutions.com",
      "https://payment.direct.worldline-solutions.com",
    ],
    frame: [
      "https://payment.preprod.direct.worldline-solutions.com",
      "https://payment.direct.worldline-solutions.com",
    ],
    connect: [
      "https://payment.preprod.direct.worldline-solutions.com",
      "https://payment.direct.worldline-solutions.com",
    ],
  },
};
