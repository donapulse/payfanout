import { describe, expect, it } from "vitest";
import { assertWellFormedIdempotencyKey, idempotencyKeyHeader, readAmount, wireInteger } from "../src/wire.js";

describe("idempotencyKeyHeader", () => {
  const DIGEST = /^payfanout-sha256-[0-9a-f]{64}$/;

  it("sends every key an earlier release could send exactly as it sent it", async () => {
    const asGiven = [
      "k",
      "k".repeat(128),
      "order-42:capture",
      "clé-é-ÿ",
      "a b c",
      "tab\tkey",
      // fetch trims edge whitespace, so these went out, and still go out, as "order-42" or 128 characters.
      "order-42\n",
      "\r\norder-42",
      " order-42 ",
      `${"k".repeat(128)} `,
      `${"k".repeat(128)}\r\n`,
      // The Fetch standard lets a header carry these, so a runtime may have sent them; Node's fetch refuses them.
      "bell\u0007",
      "del\u007f",
    ];
    for (const key of asGiven) {
      expect(await idempotencyKeyHeader(key), JSON.stringify(key)).toBe(key);
    }
  });

  it("sends a key over 128 characters once trimmed, or one no fetch can carry, as a digest of itself", async () => {
    const digested = [
      "k".repeat(129),
      ` ${"k".repeat(129)}`,
      "x".repeat(4000),
      "key-€-1",
      "key-—",
      "line\nbreak",
      "cr\rkey",
      "nul\u0000",
    ];
    for (const key of digested) {
      const header = await idempotencyKeyHeader(key);
      expect(header, JSON.stringify(key)).toMatch(DIGEST);
      expect(header.length).toBeLessThanOrEqual(128);
      // The same key always yields the same header, so a retry replays.
      expect(await idempotencyKeyHeader(key)).toBe(header);
    }
    expect(await idempotencyKeyHeader("k".repeat(129))).not.toBe(await idempotencyKeyHeader("k".repeat(130)));
    // Keys that differ only in their edge whitespace are different keys once digested.
    expect(await idempotencyKeyHeader(` ${"k".repeat(129)}`)).not.toBe(await idempotencyKeyHeader("k".repeat(129)));
  });
});

describe("assertWellFormedIdempotencyKey", () => {
  it("refuses a key holding a lone surrogate, which would share its digest and refund stamp with others", () => {
    for (const key of ["order-\uD800", "order-\uDC00", "\uDE00\uD83D"]) {
      expect(() => assertWellFormedIdempotencyKey(key), JSON.stringify(key)).toThrowError(/lone surrogate/);
    }
  });

  it("accepts well-formed text, astral characters included, and leaves a missing key to the caller's contract", () => {
    for (const key of ["order-42", "order-😀", "order-�", "", "clé"]) {
      expect(() => assertWellFormedIdempotencyKey(key), key).not.toThrow();
    }
    expect(() => assertWellFormedIdempotencyKey(undefined as never)).not.toThrow();
  });
});

describe("wireInteger: GoCardless's integer-or-string encoding", () => {
  it("reads safe non-negative integers, and strings of ASCII digits naming one", () => {
    const readable: Array<[unknown, number]> = [
      [0, 0],
      [1099, 1099],
      ["0", 0],
      ["1099", 1099],
      ["007", 7],
      [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
      [String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
    ];
    for (const [value, expected] of readable) expect(wireInteger(value), JSON.stringify(value)).toBe(expected);
  });

  it("reads nothing else: no fraction, sign, exponent, padding, other digits, unsafe integer or other type", () => {
    const unreadable: unknown[] = [
      undefined,
      null,
      "",
      " 5",
      "5 ",
      "+5",
      "-5",
      "-0",
      -5,
      10.5,
      "10.5",
      "10.00",
      "1e3",
      1e21,
      "0x10",
      "1_000",
      "９",
      "٣",
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
      "9007199254740992",
      true,
      {},
      [5],
      BigInt(5),
    ];
    for (const value of unreadable) expect(wireInteger(value), String(value)).toBeUndefined();
  });
});

describe("readAmount", () => {
  it("reads an omitted amount as 0, and a readable one as its number", () => {
    expect(readAmount(undefined, "payment", {})).toBe(0);
    expect(readAmount(null, "payment", {})).toBe(0);
    expect(readAmount(250, "refund", {})).toBe(250);
    expect(readAmount("250", "refund", {})).toBe(250);
  });

  it("fails closed on an amount that does not read, naming the resource and keeping it on raw", () => {
    const raw = { id: "SB123", amount: "2.50" };
    expect(() => readAmount("2.50", "subscription", raw)).toThrow(
      expect.objectContaining({
        code: "unknown",
        retryable: false,
        pspName: "gocardless",
        message: "GoCardless returned a subscription whose amount is not a whole number of minor units.",
        raw,
      }),
    );
  });
});
