import type { AdapterOnboardingDescriptor } from "@payfanout/core";

/**
 * Declarative onboarding metadata for the GoCardless server adapter: the two
 * server secrets a host collects, the webhook resource types the parser
 * recognizes, and an empty CSP. The credential keys mirror
 * `GoCardlessServerAdapterConfig` and the event list mirrors the `resource_type`
 * values `webhook.ts`'s `mapEventType` handles — keep the three in step. There
 * is no client-scope credential: GoCardless has no browser SDK, the client
 * adapter hands off to a full-page hosted authorisation redirect instead.
 */
export const gocardlessOnboarding: AdapterOnboardingDescriptor = {
  pspName: "gocardless",
  credentialFields: [
    { key: "accessToken", kind: "secret", scope: "server", format: { hint: "Read-write access token from the GoCardless dashboard" } },
    { key: "webhookSecret", kind: "secret", scope: "server", format: { hint: "Webhook endpoint secret from the dashboard" } },
  ],
  webhook: {
    signature: "hmac-sha256-hex",
    // GoCardless webhooks are {resource_type, action} pairs — subscribe by
    // resource type in the dashboard (mapEventType maps exactly these three).
    events: ["payments", "refunds", "billing_requests"],
  },
  // Redirect-only: the hosted flow is a full-page redirect with no embedded SDK
  // on the host page, so there is no CSP surface to allow.
  csp: { script: [], frame: [], connect: [] },
};
