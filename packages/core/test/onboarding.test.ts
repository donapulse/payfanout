import { describe, expect, it } from "vitest";
import {
  validateOnboardingDescriptor,
  type AdapterOnboardingDescriptor,
  type ServerPaymentAdapter,
} from "../src/index.js";

// The validator only reads adapter.pspName, so a minimal stand-in suffices.
const adapter = { pspName: "acme" } as ServerPaymentAdapter;

function valid(): AdapterOnboardingDescriptor {
  return {
    pspName: "acme",
    credentialFields: [
      { key: "secretKey", kind: "secret", scope: "server", format: { pattern: "^sk_" } },
      { key: "publishableKey", kind: "public", scope: "client" },
      { key: "webhookId", kind: "secret", scope: "server", required: false },
    ],
    webhook: { signature: "hmac-sha256-hex", events: ["payment.ok", "payment.fail"] },
    csp: { script: ["https://sdk.acme.test"], frame: [], connect: ["https://api.acme.test"] },
  };
}

describe("validateOnboardingDescriptor", () => {
  it("accepts a well-formed descriptor", () => {
    expect(validateOnboardingDescriptor(valid(), adapter)).toEqual([]);
  });

  it("flags a pspName mismatch", () => {
    const d = valid();
    d.pspName = "other";
    expect(validateOnboardingDescriptor(d, adapter).join(" ")).toMatch(/does not match/);
  });

  it("flags empty credentialFields", () => {
    const d = valid();
    d.credentialFields = [];
    const issues = validateOnboardingDescriptor(d, adapter);
    expect(issues.some((i) => /no credentialFields/.test(i))).toBe(true);
  });

  it("flags a repeated credential key", () => {
    const d = valid();
    d.credentialFields.push({ key: "secretKey", kind: "secret", scope: "server" });
    expect(validateOnboardingDescriptor(d, adapter).join(" ")).toMatch(/repeats credential field "secretKey"/);
  });

  it("flags an empty credential key", () => {
    const d = valid();
    d.credentialFields.push({ key: "", kind: "secret", scope: "server" });
    expect(validateOnboardingDescriptor(d, adapter).join(" ")).toMatch(/empty key/);
  });

  it("flags invalid kind and scope", () => {
    const d = valid();
    d.credentialFields = [{ key: "k", kind: "wrong" as never, scope: "nowhere" as never }];
    const issues = validateOnboardingDescriptor(d, adapter).join(" ");
    expect(issues).toMatch(/invalid kind/);
    expect(issues).toMatch(/invalid scope/);
  });

  it("flags an invalid format.pattern", () => {
    const d = valid();
    d.credentialFields[0]!.format = { pattern: "([" };
    expect(validateOnboardingDescriptor(d, adapter).join(" ")).toMatch(/invalid format\.pattern/);
  });

  it("flags a descriptor with no server-scope credential", () => {
    const d = valid();
    d.credentialFields = [{ key: "publishableKey", kind: "public", scope: "client" }];
    expect(validateOnboardingDescriptor(d, adapter).join(" ")).toMatch(/no server-scope credential/);
  });

  it("flags an unknown webhook signature scheme", () => {
    const d = valid();
    d.webhook.signature = "rsa-sha1" as never;
    expect(validateOnboardingDescriptor(d, adapter).join(" ")).toMatch(/unknown webhook\.signature/);
  });

  it("accepts an omitted webhook.events list (PSPs with no discrete event types)", () => {
    const d = valid();
    delete d.webhook.events;
    expect(validateOnboardingDescriptor(d, adapter)).toEqual([]);
  });

  it("flags an empty (but present) webhook.events list", () => {
    const d = valid();
    d.webhook.events = [];
    expect(validateOnboardingDescriptor(d, adapter).join(" ")).toMatch(/empty webhook\.events/);
  });

  it("flags a blank webhook event identifier", () => {
    const d = valid();
    d.webhook.events = ["ok", ""];
    expect(validateOnboardingDescriptor(d, adapter).join(" ")).toMatch(/empty webhook event/);
  });

  it("flags an empty CSP host", () => {
    const d = valid();
    d.csp.script = [""];
    expect(validateOnboardingDescriptor(d, adapter).join(" ")).toMatch(/empty csp\.script host/);
  });
});
