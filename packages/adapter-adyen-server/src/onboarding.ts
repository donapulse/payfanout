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
        // Whole bytes of hex, as hexToBytes requires: a key that passes this
        // pattern never fails the adapter's constructor.
        pattern: "^(?:[0-9a-fA-F]{2})+$",
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
    // Adyen's recommended policy allows scripts from *.adyen.com and sets
    // frame-src and connect-src to a bare `*`: 3-D Secure 2 challenges load from
    // issuer domains Adyen cannot list, so a host list can block them. A bare
    // wildcard is not a host, so those two stay empty, core's convention for a
    // documented wildcard; the setup guide spells out every directive, including
    // the style-src, img-src and form-action this type cannot express.
    script: ["https://*.adyen.com"],
    frame: [],
    connect: [],
  },
};
