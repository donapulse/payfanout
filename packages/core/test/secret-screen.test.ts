import { describe, expect, it } from "vitest";
import { isPayFanoutError, repeatsSecret } from "@payfanout/core";

const SECRET = "0123456789abcdefghij";

/** The PayFanoutError a call with `span` throws, if any. */
function refusal(span: number): unknown {
  try {
    repeatsSecret("x", [SECRET], span);
  } catch (err) {
    return isPayFanoutError(err) ? err : undefined;
  }
  return undefined;
}

describe("repeatsSecret", () => {
  it("flags a text holding a secret whole", () => {
    expect(repeatsSecret(SECRET, [SECRET])).toBe(true);
    expect(repeatsSecret(`Bearer ${SECRET} rejected`, [SECRET])).toBe(true);
  });

  it("flags eight characters of a secret, from its start, its middle or its end", () => {
    for (const text of ["x-01234567-y", "x-6789abcd-y", "x-cdefghij-y"]) {
      expect(repeatsSecret(text, [SECRET]), text).toBe(true);
    }
  });

  it("ignores letter case on both sides", () => {
    expect(repeatsSecret("X-CDEFGHIJ-Y", [SECRET])).toBe(true);
    expect(repeatsSecret("x-abcdefgh-y", ["ABCDEFGHIJ"])).toBe(true);
    expect(repeatsSecret("x-AbCdEfGh-y", ["aBcDeFgHiJ"])).toBe(true);
    expect(repeatsSecret("CLÉ-SECRÈTE", ["clé-secrète-42"])).toBe(true);
  });

  it("does not flag seven characters of a secret", () => {
    for (const text of ["x-0123456-y", "x-789abcd-y", "x-defghij-y", "0123456_789abcd"]) {
      expect(repeatsSecret(text, [SECRET]), text).toBe(false);
    }
  });

  it("matches a secret shorter than the span only whole", () => {
    expect(repeatsSecret("K7_ECHO", ["K7"])).toBe(true);
    expect(repeatsSecret("k7_echo", ["K7"])).toBe(true);
    expect(repeatsSecret("K_7_ECHO", ["K7"])).toBe(false);
    expect(repeatsSecret("x-01234567-y", ["01234567"])).toBe(true);
    expect(repeatsSecret("x-0123456-y", ["01234567"])).toBe(false);
  });

  it("fails safe on an empty secret, withholding any text", () => {
    expect(repeatsSecret("path_not_found", [""])).toBe(true);
    expect(repeatsSecret("", [""])).toBe(true);
    expect(repeatsSecret("path_not_found", [SECRET, ""])).toBe(true);
  });

  it("checks every secret it is given", () => {
    const secrets = ["FAKEKEYID0123456789", "fAkE/SECRETKEY42+aPiKeY0987654321="];
    expect(repeatsSecret("ECHO_FAKEKEYI", secrets)).toBe(true);
    expect(repeatsSecret("SECRETKEY42", secrets)).toBe(true);
    expect(repeatsSecret("APIKEY09", secrets)).toBe(true);
    expect(repeatsSecret("UNKNOWN_PAYMENT_ID", secrets)).toBe(false);
    expect(repeatsSecret("SECRETKEY42", [])).toBe(false);
  });

  it("flags nothing in a text unrelated to the secrets", () => {
    for (const text of ["path_not_found", "UNKNOWN_PAYMENT_ID", "<html><body>Not Found</body></html>", ""]) {
      expect(repeatsSecret(text, [SECRET, "sandbox_fragmenttoken_1234"]), text).toBe(false);
    }
  });

  it("takes another span, and refuses one that is not a positive integer", () => {
    expect(repeatsSecret("x-0123-y", [SECRET], 4)).toBe(true);
    expect(repeatsSecret("x-012-y", [SECRET], 4)).toBe(false);
    expect(repeatsSecret("x-9abcdefghij-y", [SECRET], 11)).toBe(true);
    expect(repeatsSecret("x-abcdefghij-y", [SECRET], 11)).toBe(false);
    for (const span of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(refusal(span), String(span)).toMatchObject({
        code: "invalid_request",
        message: expect.stringMatching(/span must be a positive integer/),
      });
    }
  });
});
