import { describe, expect, it } from "vitest";
import { lowercaseKeys, normalizeSecrets, normalizeTime } from "../src/webhook-util.js";

describe("lowercaseKeys", () => {
  it("lowercases header names and tolerates a missing map", () => {
    expect(lowercaseKeys({ "Stripe-Signature": "sig", ACCEPT: "json" })).toEqual({
      "stripe-signature": "sig",
      accept: "json",
    });
    expect(lowercaseKeys(undefined as unknown as Record<string, string>)).toEqual({});
  });
});

describe("normalizeTime", () => {
  it("normalizes parseable timestamps and falls back deterministically", () => {
    expect(normalizeTime("2026-07-04T10:00:00Z")).toBe("2026-07-04T10:00:00.000Z");
    expect(normalizeTime("not-a-date")).toBe("1970-01-01T00:00:00.000Z");
    expect(normalizeTime(undefined)).toBe("1970-01-01T00:00:00.000Z");
  });
});

describe("normalizeSecrets", () => {
  it("wraps a single secret, keeps arrays, and drops empty entries", () => {
    expect(normalizeSecrets("whsec_1")).toEqual(["whsec_1"]);
    expect(normalizeSecrets(["old", "new"])).toEqual(["old", "new"]);
    expect(normalizeSecrets(["", "live", undefined as unknown as string])).toEqual(["live"]);
    expect(normalizeSecrets("")).toEqual([]);
    expect(normalizeSecrets(undefined)).toEqual([]);
  });
});
