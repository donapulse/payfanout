import { describe, expect, it } from "vitest";
import { isPayFanoutError, PayFanoutError, type PaymentInfo } from "@payfanout/core";
import { resolveConfirmOutcome } from "../src/pay-logic.js";

const info: PaymentInfo = {
  id: "order-1",
  pspName: "paysafe",
  pspPaymentId: "pay_1",
  status: "succeeded",
  amount: 1000,
  amountRefunded: 0,
  currency: "USD",
  paymentMethodType: "card",
  createdAt: "2026-07-04T00:00:00.000Z",
  raw: {},
};

describe("resolveConfirmOutcome (§4a branching)", () => {
  it("passes confirm-on-client results straight through (Stripe shape)", async () => {
    const result = await resolveConfirmOutcome({ status: "succeeded" });
    expect(result).toEqual({ status: "succeeded" });
  });

  it("propagates confirm errors without invoking server completion", async () => {
    const error = PayFanoutError.wrap(new Error("declined"), { code: "card_declined" });
    let completions = 0;
    const result = await resolveConfirmOutcome({ status: "failed", error }, async () => {
      completions++;
      return info;
    });
    expect(result.error).toBe(error);
    expect(completions).toBe(0);
  });

  it("routes tokenize-first results through onServerCompletion (Paysafe shape)", async () => {
    const seen: string[] = [];
    const result = await resolveConfirmOutcome(
      { status: "requires_confirmation", clientToken: "SPtok_1" },
      async (token) => {
        seen.push(token);
        return info;
      },
    );
    expect(seen).toEqual(["SPtok_1"]);
    expect(result.status).toBe("succeeded");
    expect(result.info).toBe(info);
  });

  it("fails loudly when a tokenize-first PSP is used without onServerCompletion", async () => {
    const result = await resolveConfirmOutcome({ status: "requires_confirmation", clientToken: "SPtok_1" });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("invalid_request");
    expect(result.error?.message).toMatch(/onServerCompletion/);
  });

  it("wraps server-completion failures into PayFanoutError", async () => {
    const boom = new Error("host API 500");
    const result = await resolveConfirmOutcome(
      { status: "requires_confirmation", clientToken: "SPtok_1" },
      async () => {
        throw boom;
      },
    );
    expect(result.status).toBe("failed");
    expect(isPayFanoutError(result.error)).toBe(true);
    expect(result.error?.raw).toBe(boom);
  });
});
