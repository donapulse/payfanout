import type { AdapterOnboardingDescriptor } from "@payfanout/core";

/**
 * Declarative onboarding metadata for the Adyen adapter pair: the credentials a
 * host collects, the provider event codes a host subscribes its standard webhook
 * to, and the CSP sources Adyen Web needs. The credential keys mirror
 * `AdyenServerAdapterConfig` plus the client adapter's `clientKey`. The event
 * list is exactly what `webhook.ts` maps, so a host's subscription screen and the
 * parser cannot drift.
 *
 * `csp` follows Adyen's recommended policy: `script` allows `https://*.adyen.com`,
 * and `frame` and `connect` are a bare `"*"`. 3-D Secure 2 challenge frames load
 * from issuer domains Adyen cannot list, so a list of hosts would block them.
 * The page also needs `style-src https://*.adyen.com` for the Adyen Web
 * stylesheet, plus `img-src *` and `form-action *` from the same policy, none of
 * which this type has a field for; the Content-Security-Policy tip in
 * [Set up Adyen](https://donapulse.github.io/payfanout/guide/adyen#_5-wire-the-client-adapter)
 * lists every directive and why.
 */
export const adyenOnboarding: AdapterOnboardingDescriptor = {
  pspName: "adyen",
  credentialFields: [
    {
      key: "apiKey",
      kind: "secret",
      scope: "server",
      format: {
        hint:
          "API key of the API credential (sent as X-API-Key); the credential also needs the " +
          "Checkout encrypted cardholder data role, which Adyen does not assign by default",
      },
    },
    {
      key: "merchantAccount",
      kind: "public",
      scope: "server",
      format: {
        hint: "Merchant account name as the Customer Area account switcher shows it (case-sensitive)",
      },
    },
    {
      key: "hmacKey",
      kind: "secret",
      scope: "server",
      format: {
        // Exactly the keys the adapter accepts: whole bytes of hex, with the
        // surrounding whitespace hexToBytes trims.
        pattern: "^\\s*(?:[0-9a-fA-F]{2})+\\s*$",
        hint:
          "Hex HMAC key generated on the webhook (one key per webhook endpoint; the live key " +
          "differs from the test one)",
      },
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
      format: {
        // The prefix is one hostname label: a pasted URL or host name fails.
        pattern: "^[^\\s/:.]+$",
        hint:
          "Live URL prefix from Developers > API URLs > Prefix in the live Customer Area, " +
          "e.g. 1797a841fbb37ca7-AdyenDemo (the prefix only, not a URL) — required on live only",
      },
    },
    {
      key: "clientKey",
      kind: "public",
      scope: "client",
      format: {
        pattern: "^(test|live)_",
        hint:
          "Browser-safe client key (test_… / live_…); list every checkout origin under the API " +
          "credential's allowed origins, https only on live",
      },
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
    script: ["https://*.adyen.com"],
    frame: ["*"],
    connect: ["*"],
  },
};
