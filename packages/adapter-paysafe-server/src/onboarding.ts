import type { AdapterOnboardingDescriptor } from "@payfanout/core";
import { PAYSAFE_DOCUMENTED_WEBHOOK_EVENTS } from "./webhook.js";

/**
 * Declarative onboarding metadata for the Paysafe adapter pair: the credentials a
 * host collects, the provider event-type strings the webhook parser recognizes,
 * and the CSP hosts Paysafe.js touches. The credential keys mirror
 * `PaysafeServerAdapterConfig` (plus the client-scope `apiKey` Paysafe.js needs to
 * tokenize) — keep the two in step. The event list is the documented part of
 * `webhook.ts`'s event map, so hosts never subscribe to a name Paysafe does not
 * publish. `merchantAccount` is descriptive: the runtime config takes a
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
    events: [...PAYSAFE_DOCUMENTED_WEBHOOK_EVENTS],
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
