import { describe, expect, it } from "vitest";
import { SCRUBBED, scrubForLogging } from "../src/index.js";

describe("scrubForLogging", () => {
  it("redacts sensitive keys across naming conventions, keeps operational fields", () => {
    const scrubbed = scrubForLogging({
      id: "pay_1",
      amount: 1099,
      status: "COMPLETED",
      receipt_email: "a@b.c",
      receiptEmail: "a@b.c",
      holderName: "Ann Buyer",
      paymentHandleToken: "SChandle123",
      client_secret: "pi_1_secret_xyz",
      authorization: "Basic abc",
    }) as Record<string, unknown>;
    expect(scrubbed["id"]).toBe("pay_1");
    expect(scrubbed["amount"]).toBe(1099);
    expect(scrubbed["status"]).toBe("COMPLETED");
    for (const key of ["receipt_email", "receiptEmail", "holderName", "paymentHandleToken", "client_secret", "authorization"]) {
      expect(scrubbed[key], key).toBe(SCRUBBED);
    }
  });

  it("wholly redacts card/billing/shipping/profile subtrees", () => {
    const scrubbed = scrubForLogging({
      card: { lastDigits: "1111", expiry: { month: 12 } },
      billingDetails: { zip: "10001", country: "US" },
      shippingDetails: { street: "1 Way" },
      profile: { email: "x@y.z" },
      settlement: { id: "stl_1", amount: 500 },
    }) as Record<string, unknown>;
    expect(scrubbed["card"]).toBe(SCRUBBED);
    expect(scrubbed["billingDetails"]).toBe(SCRUBBED);
    expect(scrubbed["shippingDetails"]).toBe(SCRUBBED);
    expect(scrubbed["profile"]).toBe(SCRUBBED);
    expect(scrubbed["settlement"]).toEqual({ id: "stl_1", amount: 500 });
  });

  it("masks Luhn-valid card numbers inside strings, leaves other digit runs alone", () => {
    const scrubbed = scrubForLogging({
      message: "declined card 4111 1111 1111 1111 at gateway",
      note: "card 4111-1111-1111-1111 retried",
      orderRef: "order 1234567890123 confirmed", // 13 digits, fails Luhn -> untouched
    }) as Record<string, unknown>;
    expect(scrubbed["message"]).toBe("declined card ************1111 at gateway");
    expect(scrubbed["note"]).toBe("card ************1111 retried");
    expect(scrubbed["orderRef"]).toBe("order 1234567890123 confirmed");
  });

  it("handles arrays, Maps, Sets, Dates and Errors", () => {
    const err = new Error("boom with 4242424242424242 inside");
    const scrubbed = scrubForLogging({
      list: [{ email: "x@y.z" }, "plain"],
      map: new Map([["token", "tok_1"]]),
      set: new Set(["a"]),
      when: new Date("2026-07-04T00:00:00.000Z"),
      err,
    }) as Record<string, unknown>;
    expect(scrubbed["list"]).toEqual([{ email: SCRUBBED }, "plain"]);
    expect(scrubbed["map"]).toEqual([["token", "tok_1"]]); // entries survive; key-based redaction is for objects
    expect(scrubbed["set"]).toEqual(["a"]);
    expect(scrubbed["when"]).toBe("2026-07-04T00:00:00.000Z");
    expect((scrubbed["err"] as { message: string }).message).toBe("boom with ************4242 inside");
    expect((scrubbed["err"] as { name: string }).name).toBe("Error");
  });

  it("survives circular references and cuts over-deep nesting", () => {
    const circular: Record<string, unknown> = { id: 1 };
    circular["self"] = circular;
    expect(scrubForLogging(circular)).toEqual({ id: 1, self: "[circular]" });

    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 20; i++) deep = { child: deep };
    const scrubbed = JSON.stringify(scrubForLogging(deep));
    expect(scrubbed).toContain(SCRUBBED); // depth guard kicked in somewhere
  });

  it("honors extraKeys and never mutates the input", () => {
    const original = { internalNote: "keep-off-logs", amount: 5 };
    const scrubbed = scrubForLogging(original, { extraKeys: ["internal_note"] }) as Record<string, unknown>;
    expect(scrubbed["internalNote"]).toBe(SCRUBBED);
    expect(original.internalNote).toBe("keep-off-logs");
  });

  it("passes through primitives and redacts functions/symbols", () => {
    expect(scrubForLogging(null)).toBeNull();
    expect(scrubForLogging(42)).toBe(42);
    expect(scrubForLogging(true)).toBe(true);
    expect(scrubForLogging("no digits")).toBe("no digits");
    expect(scrubForLogging(() => "x")).toBe(SCRUBBED);
    expect(scrubForLogging(Symbol("s"))).toBe(SCRUBBED);
  });
});
