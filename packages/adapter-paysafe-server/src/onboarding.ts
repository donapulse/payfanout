import type { AdapterOnboardingDescriptor } from "@payfanout/core";

/**
 * Declarative onboarding metadata for the Paysafe adapter pair: the credentials a
 * host collects, the provider event-type strings the webhook parser recognizes,
 * and the CSP hosts Paysafe.js touches. The credential keys mirror
 * `PaysafeServerAdapterConfig` (plus the client-scope `apiKey` Paysafe.js needs to
 * tokenize) and the event list mirrors `webhook.ts`'s EVENT_TYPE_MAP — keep the
 * three in step. `merchantAccount` is descriptive: the runtime config takes a
 * `merchantAccountResolver` function instead, since Paysafe routes per currency.
 */
export const paysafeOnboarding: AdapterOnboardingDescriptor = {
  pspName: "paysafe",
  credentialFields: [
    { key: "username", kind: "secret", scope: "server", format: { hint: "Paysafe API username (HTTP Basic auth)" } },
    { key: "password", kind: "secret", scope: "server", format: { hint: "Paysafe API password" } },
    {
      key: "apiKey",
      kind: "public",
      scope: "client",
      format: {
        hint: "Base64 single-use-token public key (OT-<id>:<key> base64-encoded) for Paysafe.js — NOT the raw key password",
      },
    },
    {
      key: "sessionSigningKey",
      kind: "secret",
      scope: "server",
      format: { hint: "Host-generated HMAC key that signs the stateless session context" },
    },
    { key: "webhookHmacKey", kind: "secret", scope: "server", format: { hint: "Paysafe webhook HMAC key" } },
    {
      key: "merchantAccount",
      kind: "public",
      scope: "server",
      required: false,
      perCurrency: true,
      format: {
        hint: "Per-currency merchant account id; omit for single-account keys (Paysafe routes by key + currency)",
      },
    },
  ],
  webhook: {
    signature: "hmac-sha256-base64",
    events: [
      "PAYMENT_COMPLETED",
      "PAYMENT_FAILED",
      "PAYMENT_DECLINED",
      "PAYMENT_CANCELLED",
      "PAYMENT_EXPIRED",
      "PAYMENT_AUTHENTICATION_REQUIRED",
      "PAYMENT_PROCESSING",
      "PAYMENT_PENDING",
      "PAYMENT_RECEIVED",
      "PAYMENT_HELD",
      "REFUND_COMPLETED",
      "REFUND_FAILED",
      "REFUND_DECLINED",
      "REFUND_ERROR",
    ],
  },
  csp: {
    script: ["https://hosted.paysafe.com"],
    frame: ["https://hosted.paysafe.com", "https://hosted.test.paysafe.com"],
    connect: [
      "https://hosted.paysafe.com",
      "https://hosted.test.paysafe.com",
      "https://api.paysafe.com",
      "https://api.test.paysafe.com",
    ],
  },
};
