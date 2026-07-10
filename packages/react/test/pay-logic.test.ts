import { describe, expect, it, vi } from "vitest";
import { isPayFanoutError, PayFanoutError, type PaymentInfo } from "@payfanout/core";
import { createEndpointCompletion, resolveConfirmOutcome } from "../src/pay-logic.js";

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

describe("createEndpointCompletion", () => {
  function fakeFetch(status: number, body: unknown) {
    return vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(body === undefined ? "" : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  }

  it("POSTs the wire contract and resolves with the PaymentInfo on 2xx", async () => {
    const fetchImpl = fakeFetch(200, info);
    const complete = createEndpointCompletion("/api/complete", "cs_ref", undefined, fetchImpl as unknown as typeof fetch);

    const result = await complete("handle_1");

    expect(result).toEqual(info);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("/api/complete");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ sessionRef: "cs_ref", clientToken: "handle_1" });
  });

  it("includes billingDetails in the body only when provided", async () => {
    const fetchImpl = fakeFetch(200, info);
    const complete = createEndpointCompletion(
      "/c",
      "cs",
      { address: { postalCode: "10001" } },
      fetchImpl as unknown as typeof fetch,
    );

    await complete("t");

    expect(JSON.parse(fetchImpl.mock.calls[0]![1]?.body as string)).toEqual({
      sessionRef: "cs",
      clientToken: "t",
      billingDetails: { address: { postalCode: "10001" } },
    });
  });

  it("rebuilds a PayFanoutError from a non-2xx { error } body, preserving code/message/retryable/pspName", async () => {
    const fetchImpl = fakeFetch(402, {
      error: { name: "PayFanoutError", code: "card_declined", message: "Your card was declined.", retryable: false, pspName: "paysafe" },
    });
    const complete = createEndpointCompletion("/c", "cs", undefined, fetchImpl as unknown as typeof fetch);

    let thrown: unknown;
    await complete("t").catch((e: unknown) => {
      thrown = e;
    });
    expect(isPayFanoutError(thrown)).toBe(true);
    expect(thrown).toMatchObject({ code: "card_declined", message: "Your card was declined.", retryable: false, pspName: "paysafe" });
  });

  it("falls back to a generic unknown error when the non-2xx body is missing or unparseable", async () => {
    const fetchImpl = fakeFetch(500, undefined); // empty body -> response.json() throws -> generic fallback
    const complete = createEndpointCompletion("/c", "cs", undefined, fetchImpl as unknown as typeof fetch);

    let thrown: unknown;
    await complete("t").catch((e: unknown) => {
      thrown = e;
    });
    expect(isPayFanoutError(thrown)).toBe(true);
    expect((thrown as PayFanoutError).code).toBe("unknown");
    expect((thrown as PayFanoutError).message).toMatch(/HTTP 500/);
  });
});
