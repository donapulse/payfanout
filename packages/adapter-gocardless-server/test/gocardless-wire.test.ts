import { describe, expect, it } from "vitest";
import {
  assertDigestibleIdempotencyKey,
  assertStampableRefundKey,
  idempotencyKeyHeader,
  readAmount,
  wireInteger,
} from "../src/wire.js";

describe("idempotencyKeyHeader", () => {
  const DIGEST = /^payfanout-sha256-[0-9a-f]{64}$/;

  it("sends every key GoCardless can have taken exactly as earlier releases sent it", async () => {
    const asGiven = [
      "k",
      "k".repeat(128),
      "order-42:capture",
      "clé-é-ÿ",
      "a b c",
      "tab\tkey",
      // fetch trims edge whitespace, so these went out, and still go out, as "order-42" or 128 characters.
      "order-42\n",
      "\r\norder-42",
      " order-42 ",
      "\torder-42",
      "\norder-42\n",
      `${"k".repeat(128)} `,
      ` ${"k".repeat(128)} `,
      `${"k".repeat(128)}\t`,
      `${"k".repeat(128)}\r\n`,
      // Cloudflare Workers sends these as UTF-8, and other control characters as given; Node's fetch refuses them.
      "key-€-1",
      "key-—",
      "sub-Łódź-42",
      "注文-42",
      "😀".repeat(65),
      "😀".repeat(128),
      "order-\uD800",
      "bell\u0007",
      "del\u007f",
      // Node sends these one byte each, which read as UTF-8 are 65 characters ("é" 65 times), and a C1 control.
      "Ã©".repeat(65),
      "\u0085-order",
    ];
    for (const key of asGiven) {
      expect(await idempotencyKeyHeader(key), JSON.stringify(key)).toBe(key);
    }
  });

  it("sends a key GoCardless never took, over 128 code points once trimmed or holding NUL, CR or LF, as its digest", async () => {
    const digested = [
      "k".repeat(129),
      ` ${"k".repeat(129)}`,
      "x".repeat(4000),
      "😀".repeat(129),
      "€".repeat(129),
      // One byte each on Node, and no shorter as UTF-8: each lone 0xE9 decodes to one U+FFFD.
      "é".repeat(129),
      // Above U+00FF, so never one byte each: their low bytes would read as 65 "é" if truncated.
      "ǃƩ".repeat(65),
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
    // A long run of whitespace inside a key is read once, not once per position.
    expect(await idempotencyKeyHeader(`a${"\t".repeat(1_000_000)}a`)).toMatch(DIGEST);
    // Keys that differ only in their edge whitespace are different keys once digested.
    expect(await idempotencyKeyHeader(` ${"k".repeat(129)}`)).not.toBe(await idempotencyKeyHeader("k".repeat(129)));
  });
});

describe("assertDigestibleIdempotencyKey", () => {
  it("refuses a key sent as its digest that holds a lone surrogate, which would share the digest of other keys", () => {
    for (const key of [
      `\uD800${"k".repeat(128)}`,
      `${"k".repeat(200)}\uDC00`,
      "line\n\uD800",
      `\uD800${"\t".repeat(1_000_000)}a`,
    ]) {
      expect(() => assertDigestibleIdempotencyKey(key), JSON.stringify(key)).toThrowError(/lone surrogate/);
    }
  });

  it("accepts a key sent as given, lone surrogates included, and a well-formed key sent as its digest", () => {
    for (const key of ["order-\uD800", "order-\uD800\n", "\uDE00\uD83D", "order-42", "😀".repeat(129), "k".repeat(4000), ""]) {
      expect(() => assertDigestibleIdempotencyKey(key), JSON.stringify(key)).not.toThrow();
    }
    expect(() => assertDigestibleIdempotencyKey(undefined as never)).not.toThrow();
  });
});

describe("assertStampableRefundKey", () => {
  it("refuses a refund key holding a lone surrogate, leaving open whether an earlier release refunded under it", () => {
    for (const key of ["order-\uD800", "order-\uDC00", "\uDE00\uD83D", `${"k".repeat(200)}\uD800`]) {
      expect(() => assertStampableRefundKey(key), JSON.stringify(key)).toThrow(
        expect.objectContaining({
          code: "invalid_request",
          retryable: false,
          outcomeUnknown: true,
          pspName: "gocardless",
          message: expect.stringMatching(/lone surrogate.*check the payment's refunds/),
        }),
      );
    }
  });

  it("accepts well-formed text, astral characters included", () => {
    for (const key of ["order-42", "order-😀", "order-�", "clé", "k".repeat(4000)]) {
      expect(() => assertStampableRefundKey(key), key).not.toThrow();
    }
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
