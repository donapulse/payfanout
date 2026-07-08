import { describe, expect, it } from "vitest";
import { isUnifiedPaymentStatus, PAYMENT_STATUSES } from "../src/index.js";

describe("isUnifiedPaymentStatus", () => {
  it("accepts every member of PAYMENT_STATUSES", () => {
    for (const status of PAYMENT_STATUSES) {
      expect(isUnifiedPaymentStatus(status), status).toBe(true);
    }
  });

  it('rejects "refunded" — refund state is derived, never a payment status', () => {
    expect(isUnifiedPaymentStatus("refunded")).toBe(false);
  });

  it("rejects garbage", () => {
    for (const bad of ["", "SUCCEEDED", "succeeded ", 42, null, undefined, { status: "succeeded" }, ["succeeded"]]) {
      expect(isUnifiedPaymentStatus(bad), String(bad)).toBe(false);
    }
  });
});
