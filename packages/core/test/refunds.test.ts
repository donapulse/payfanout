import { describe, expect, it } from "vitest";
import { getRefundState } from "@payfanout/core";

describe("getRefundState", () => {
  it("derives none / partial / full from amounts", () => {
    expect(getRefundState({ amount: 1000, amountRefunded: 0 })).toBe("none");
    expect(getRefundState({ amount: 1000, amountRefunded: 400 })).toBe("partial");
    expect(getRefundState({ amount: 1000, amountRefunded: 1000 })).toBe("full");
  });

  it("treats a zero-amount payment as never refunded", () => {
    expect(getRefundState({ amount: 0, amountRefunded: 0 })).toBe("none");
  });

  it("rejects over-refunds and invalid amounts", () => {
    expect(() => getRefundState({ amount: 1000, amountRefunded: 1001 })).toThrowError(/exceeds/);
    expect(() => getRefundState({ amount: 10.5, amountRefunded: 0 })).toThrowError(/integer/);
  });
});
