import type { ServerPaymentAdapter } from "./adapters.js";

/**
 * Declarative onboarding metadata an adapter exports so a host can render a
 * provider-settings form, validate credential shapes, build CSP headers, and
 * drive "which events to subscribe" copy as GENERIC loops over the descriptor —
 * identical for every current and future adapter. It restates facts the adapter
 * already embodies (its config, its webhook parser's event map, its SDK hosts)
 * in a machine-readable form, so a host with a settings screen no longer
 * reverse-engineers them per PSP. The optional `verifyCredentials()` probe on
 * ServerPaymentAdapter is the runtime companion (a "Test connection" button).
 */

/** How a PSP authenticates its webhook deliveries — informational for onboarding docs. */
export type WebhookSignatureScheme =
  /** Local HMAC-SHA256, hex digest (Stripe, PayZen, GoCardless). */
  | "hmac-sha256-hex"
  /** Local HMAC-SHA256, base64 digest (Paysafe). */
  | "hmac-sha256-base64"
  /** Verified by calling the PSP's own API rather than local crypto (PayPal). */
  | "provider-postback";

export interface CredentialFieldDescriptor {
  /**
   * The credential a host collects — usually the adapter config key it maps to
   * (e.g. "secretKey", "publishableKey"), but may be a descriptive name for a
   * value the constructor takes differently (Paysafe's per-currency merchant
   * account is a resolver function, surfaced here as "merchantAccount").
   */
  key: string;
  /** Storage/redaction guidance: a `secret` value must never be redisplayed. */
  kind: "public" | "secret";
  /** Where the value is consumed — a `client` field ships to the browser. */
  scope: "server" | "client";
  /** Absent means required; `false` marks an optional field (a webhook id, a pinned version). */
  required?: boolean;
  /** Shape hints for input validation and help text. */
  format?: {
    /** Regex source a host can test the input against (e.g. "^pk_"). */
    pattern?: string;
    /** Human hint (e.g. "Base64 single-use-token key, not the raw key password"). */
    hint?: string;
  };
  /** True for values that vary per currency/account (Paysafe merchant accounts). */
  perCurrency?: boolean;
}

export interface AdapterOnboardingDescriptor {
  pspName: string;
  /** Credentials a host collects to onboard a merchant onto this PSP. */
  credentialFields: CredentialFieldDescriptor[];
  webhook: {
    signature: WebhookSignatureScheme;
    /**
     * Provider event-type identifiers the adapter's parser consumes — render
     * these as the "events to subscribe" list in the PSP's dashboard. Omitted
     * for PSPs that have no discrete subscribable event types (e.g. PayZen,
     * whose IPNs are order-state snapshots).
     */
    events?: string[];
  };
  /**
   * CSP hosts the PSP's browser SDK touches, by directive. Empty arrays where
   * the PSP has no embedded surface (redirect-only PSPs) or defers to a
   * documented wildcard.
   */
  csp: {
    script: string[];
    frame: string[];
    connect: string[];
  };
}

const WEBHOOK_SIGNATURE_SCHEMES: readonly WebhookSignatureScheme[] = [
  "hmac-sha256-hex",
  "hmac-sha256-base64",
  "provider-postback",
];

/**
 * Validates an onboarding descriptor is well-formed and consistent with its
 * adapter — the same drift-proofing pattern as `validateAdapterCapabilities`:
 * returns the list of problems (empty means valid) so the conformance suite can
 * assert `[]`. Checks the pspName matches, credential fields are well-formed and
 * unique with at least one server credential, `format.pattern` compiles, the
 * webhook signature scheme is known, and the event/CSP lists hold no blanks.
 */
export function validateOnboardingDescriptor(
  descriptor: AdapterOnboardingDescriptor,
  adapter: ServerPaymentAdapter,
): string[] {
  const issues: string[] = [];
  const label = descriptor.pspName || adapter.pspName || "<unknown>";

  if (descriptor.pspName !== adapter.pspName) {
    issues.push(`Descriptor pspName "${descriptor.pspName}" does not match adapter "${adapter.pspName}"`);
  }

  if (descriptor.credentialFields.length === 0) {
    issues.push(`Descriptor "${label}" lists no credentialFields`);
  }
  const seen = new Set<string>();
  for (const field of descriptor.credentialFields) {
    if (!field.key) {
      issues.push(`Descriptor "${label}" has a credential field with an empty key`);
      continue;
    }
    if (seen.has(field.key)) {
      issues.push(`Descriptor "${label}" repeats credential field "${field.key}"`);
    }
    seen.add(field.key);
    if (field.kind !== "public" && field.kind !== "secret") {
      issues.push(`Credential field "${field.key}" has invalid kind "${String(field.kind)}"`);
    }
    if (field.scope !== "server" && field.scope !== "client") {
      issues.push(`Credential field "${field.key}" has invalid scope "${String(field.scope)}"`);
    }
    if (field.format?.pattern !== undefined) {
      try {
        new RegExp(field.format.pattern);
      } catch {
        issues.push(`Credential field "${field.key}" has an invalid format.pattern`);
      }
    }
  }
  if (!descriptor.credentialFields.some((field) => field.scope === "server")) {
    issues.push(`Descriptor "${label}" has no server-scope credential field`);
  }

  if (!WEBHOOK_SIGNATURE_SCHEMES.includes(descriptor.webhook.signature)) {
    issues.push(`Descriptor "${label}" has unknown webhook.signature "${String(descriptor.webhook.signature)}"`);
  }
  if (descriptor.webhook.events !== undefined) {
    if (descriptor.webhook.events.length === 0) {
      issues.push(`Descriptor "${label}" has an empty webhook.events list (omit it if the PSP has no discrete event types)`);
    }
    if (descriptor.webhook.events.some((event) => !event)) {
      issues.push(`Descriptor "${label}" has an empty webhook event identifier`);
    }
  }

  for (const directive of ["script", "frame", "connect"] as const) {
    for (const host of descriptor.csp[directive]) {
      if (!host) issues.push(`Descriptor "${label}" has an empty csp.${directive} host`);
    }
  }

  return issues;
}
