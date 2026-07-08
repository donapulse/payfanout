import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  base64UrlToUtf8,
  bytesToBase64,
  bytesToBase64Url,
  constantTimeEqual,
  hmacSha256,
  hmacSha256Hex,
  sha256Hex,
  utf8ToBase64,
  utf8ToBase64Url,
} from "../src/webcrypto.js";

// Inputs that exercise every base64 tail length (0/1/2 padding chars) plus
// multi-byte UTF-8 — the cases where hand-rolled encoders classically break.
const SAMPLES = ["", "a", "ab", "abc", "abcd", "payfanout", "précisé — ünïcode ✓", "{\"v\":1,\"amount\":777}"];

describe("webcrypto bit-equivalence with node:crypto", () => {
  // Adapters migrated from node:crypto to WebCrypto; outstanding signed
  // tokens/signatures stay valid only if every primitive is bit-identical.
  it("hmacSha256 + bytesToBase64Url matches createHmac(...).digest('base64url')", async () => {
    for (const sample of SAMPLES) {
      const node = createHmac("sha256", "signing-key").update(sample, "utf8").digest("base64url");
      expect(bytesToBase64Url(await hmacSha256("signing-key", sample))).toBe(node);
    }
  });

  it("hmacSha256 + bytesToBase64 matches createHmac(...).digest('base64')", async () => {
    for (const sample of SAMPLES) {
      const node = createHmac("sha256", "webhook-key").update(sample, "utf8").digest("base64");
      expect(bytesToBase64(await hmacSha256("webhook-key", sample))).toBe(node);
    }
  });

  it("hmacSha256Hex matches createHmac(...).digest('hex')", async () => {
    for (const sample of SAMPLES) {
      const node = createHmac("sha256", "hex-key").update(sample, "utf8").digest("hex");
      expect(await hmacSha256Hex("hex-key", sample)).toBe(node);
    }
  });

  it("sha256Hex matches createHash('sha256').digest('hex')", async () => {
    for (const sample of SAMPLES) {
      const node = createHash("sha256").update(sample, "utf8").digest("hex");
      expect(await sha256Hex(sample)).toBe(node);
    }
  });

  it("utf8ToBase64 / utf8ToBase64Url match Buffer encodings, UTF-8 safe", () => {
    for (const sample of SAMPLES) {
      expect(utf8ToBase64(sample)).toBe(Buffer.from(sample, "utf8").toString("base64"));
      expect(utf8ToBase64Url(sample)).toBe(Buffer.from(sample, "utf8").toString("base64url"));
    }
  });

  it("base64UrlToUtf8 round-trips every sample and decodes node:crypto output", () => {
    for (const sample of SAMPLES) {
      expect(base64UrlToUtf8(utf8ToBase64Url(sample))).toBe(sample);
      expect(base64UrlToUtf8(Buffer.from(sample, "utf8").toString("base64url"))).toBe(sample);
    }
  });
});

describe("constantTimeEqual", () => {
  it("compares equal, differing, and length-mismatched strings", () => {
    expect(constantTimeEqual("signature", "signature")).toBe(true);
    expect(constantTimeEqual("signature", "signaturX")).toBe(false);
    expect(constantTimeEqual("short", "longer-value")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
    // Multi-byte characters compare by UTF-8 bytes, not code units.
    expect(constantTimeEqual("é", "é")).toBe(true);
    expect(constantTimeEqual("é", "è")).toBe(false);
  });
});
