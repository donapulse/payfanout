import { describe, expect, it } from "vitest";
import { isLiveHost } from "./live-host-guard.js";

// Regression coverage for the CodeQL js/incomplete-url-substring-sanitization
// fix in paysafe.integration.test.ts / gocardless.integration.test.ts: the
// live-API guards used to compare raw substrings of the URL, which both
// missed real bypasses and (by accident) caught some that the parsed-hostname
// check needs to keep catching.
describe("isLiveHost", () => {
  it("blocks the bare live hostname", () => {
    expect(isLiveHost("https://api.paysafe.com", "api.paysafe.com")).toBe(true);
  });

  it("blocks a case-variant of the live hostname", () => {
    expect(isLiveHost("https://API.PAYSAFE.COM", "api.paysafe.com")).toBe(true);
  });

  it("blocks a trailing-dot FQDN of the live hostname", () => {
    expect(isLiveHost("https://api.paysafe.com./x", "api.paysafe.com")).toBe(true);
  });

  it("blocks a userinfo-prefixed lookalike that substring matching would miss", () => {
    expect(isLiveHost("https://api.test.paysafe.com@api.paysafe.com/", "api.paysafe.com")).toBe(true);
  });

  it("allows the sandbox default", () => {
    expect(isLiveHost("https://api.test.paysafe.com", "api.paysafe.com")).toBe(false);
  });

  it("does not false-positive on the live hostname embedded in a path", () => {
    expect(isLiveHost("https://evil.example.com/api.paysafe.com", "api.paysafe.com")).toBe(false);
  });
});
