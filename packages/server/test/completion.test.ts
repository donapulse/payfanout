import { describe, expect, it } from "vitest";
import { PayFanoutError } from "@payfanout/core";
import {
  completionErrorStatus,
  createCompletionHandler,
  PaymentService,
  type ResolvedCompletionSession,
} from "@payfanout/server";
import { FakeAdapter } from "./fake-adapter.js";

function tokenizeFirstService(): { service: PaymentService; adapter: FakeAdapter } {
  const adapter = new FakeAdapter({ pspName: "paysafe", capabilities: { requiresServerCompletion: true } });
  return { service: new PaymentService({ adapters: [adapter] }), adapter };
}

function resolveTo(service: PaymentService, overrides: Partial<ResolvedCompletionSession> = {}) {
  return (): ResolvedCompletionSession => ({
    service,
    pspName: "paysafe",
    pspSessionId: "sess_abc",
    idempotencyKey: "idem_1",
    ...overrides,
  });
}

function post(body: unknown, url = "https://host.example/api/complete"): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("createCompletionHandler", () => {
  it("completes a payment and returns the PaymentInfo as JSON", async () => {
    const { service, adapter } = tokenizeFirstService();
    const handler = createCompletionHandler({ resolveSession: resolveTo(service) });

    const res = await handler(post({ sessionRef: "cs_live_xyz", clientToken: "handle_1" }));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    const info = (await res.json()) as { pspName: string; pspPaymentId: string; status: string };
    expect(info).toMatchObject({ pspName: "paysafe", pspPaymentId: "sess_abc", status: "succeeded" });
    const call = adapter.calls.find((c) => c.method === "completePayment");
    expect(call?.args[0]).toMatchObject({ pspSessionId: "sess_abc", clientToken: "handle_1", idempotencyKey: "idem_1" });
  });

  it("forwards completion-time billingDetails to completePayment", async () => {
    const { service, adapter } = tokenizeFirstService();
    const handler = createCompletionHandler({ resolveSession: resolveTo(service) });

    await handler(post({ sessionRef: "cs", clientToken: "t", billingDetails: { address: { postalCode: "10001" } } }));

    const call = adapter.calls.find((c) => c.method === "completePayment");
    expect(call?.args[0]).toMatchObject({ billingDetails: { address: { postalCode: "10001" } } });
  });

  it("runs onCompleted with the info and context before responding", async () => {
    const { service } = tokenizeFirstService();
    const seen: Array<{ id: string; sessionRef: string; pspName: string }> = [];
    const handler = createCompletionHandler({
      resolveSession: resolveTo(service),
      onCompleted: (info, ctx) => void seen.push({ id: info.pspPaymentId, sessionRef: ctx.sessionRef, pspName: ctx.pspName }),
    });

    const res = await handler(post({ sessionRef: "cs_ref", clientToken: "t" }));

    expect(res.status).toBe(200);
    expect(seen).toEqual([{ id: "sess_abc", sessionRef: "cs_ref", pspName: "paysafe" }]);
  });

  it("rejects a non-POST request with 405", async () => {
    const { service } = tokenizeFirstService();
    const handler = createCompletionHandler({ resolveSession: resolveTo(service) });

    const res = await handler(new Request("https://host.example/api/complete", { method: "GET" }));

    expect(res.status).toBe(405);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_request");
  });

  it("rejects a non-JSON body with 400", async () => {
    const { service } = tokenizeFirstService();
    const handler = createCompletionHandler({ resolveSession: resolveTo(service) });

    const res = await handler(new Request("https://host.example/api/complete", { method: "POST", body: "not-json{" }));

    expect(res.status).toBe(400);
  });

  it("rejects a missing sessionRef with 400", async () => {
    const { service } = tokenizeFirstService();
    const handler = createCompletionHandler({ resolveSession: resolveTo(service) });

    const res = await handler(post({ clientToken: "t" }));

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/sessionRef/);
  });

  it("rejects a missing clientToken with 400", async () => {
    const { service } = tokenizeFirstService();
    const handler = createCompletionHandler({ resolveSession: resolveTo(service) });

    const res = await handler(post({ sessionRef: "cs" }));

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/clientToken/);
  });

  it("maps a card decline from completePayment to 402 and preserves the code + pspName", async () => {
    const { service, adapter } = tokenizeFirstService();
    adapter.completePayment = async () => {
      throw new PayFanoutError({ code: "card_declined", message: "Your card was declined.", retryable: false });
    };
    const handler = createCompletionHandler({ resolveSession: resolveTo(service) });

    const res = await handler(post({ sessionRef: "cs", clientToken: "t" }));

    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: unknown }).error).toMatchObject({
      code: "card_declined",
      retryable: false,
      pspName: "paysafe",
    });
  });

  it("maps a resolveSession rejection to the matching status (unknown reference -> 400)", async () => {
    const handler = createCompletionHandler({
      resolveSession: () => {
        throw PayFanoutError.invalidRequest("unknown session reference");
      },
    });

    const res = await handler(post({ sessionRef: "nope", clientToken: "t" }));

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_request");
  });

  it("maps an expired session token to 410", async () => {
    const handler = createCompletionHandler({
      resolveSession: () => {
        throw new PayFanoutError({ code: "session_expired", message: "This session has expired." });
      },
    });

    const res = await handler(post({ sessionRef: "old", clientToken: "t" }));

    expect(res.status).toBe(410);
  });

  it("returns 500 when onCompleted throws after the payment already completed", async () => {
    const { service } = tokenizeFirstService();
    const handler = createCompletionHandler({
      resolveSession: resolveTo(service),
      onCompleted: () => {
        throw new Error("host database is down");
      },
    });

    const res = await handler(post({ sessionRef: "cs", clientToken: "t" }));

    expect(res.status).toBe(500);
  });

  it("maps a confirm-on-client PSP (no server completion) to 422", async () => {
    const adapter = new FakeAdapter({ pspName: "stripe" }); // requiresServerCompletion: false
    const service = new PaymentService({ adapters: [adapter] });
    const handler = createCompletionHandler({
      resolveSession: () => ({ service, pspName: "stripe", pspSessionId: "s", idempotencyKey: "k" }),
    });

    const res = await handler(post({ sessionRef: "cs", clientToken: "t" }));

    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("unsupported_operation");
  });

  it("does not read the request body twice (resolveSession receives a body-consumed request)", async () => {
    const { service } = tokenizeFirstService();
    let sawSessionRef = "";
    const handler = createCompletionHandler({
      resolveSession: (sessionRef, request) => {
        sawSessionRef = sessionRef;
        // Reading headers/URL is fine; the body is already consumed by the handler.
        expect(request.bodyUsed).toBe(true);
        return { service, pspName: "paysafe", pspSessionId: "s", idempotencyKey: "k" };
      },
    });

    const res = await handler(post({ sessionRef: "cs_ref", clientToken: "t" }));

    expect(res.status).toBe(200);
    expect(sawSessionRef).toBe("cs_ref");
  });
});

describe("completionErrorStatus", () => {
  it("maps the full error taxonomy to HTTP statuses", () => {
    expect(completionErrorStatus("card_declined")).toBe(402);
    expect(completionErrorStatus("insufficient_funds")).toBe(402);
    expect(completionErrorStatus("expired_card")).toBe(402);
    expect(completionErrorStatus("invalid_card_data")).toBe(402);
    expect(completionErrorStatus("fraud_suspected")).toBe(402);
    expect(completionErrorStatus("authentication_required")).toBe(402);
    expect(completionErrorStatus("invalid_request")).toBe(400);
    expect(completionErrorStatus("session_expired")).toBe(410);
    expect(completionErrorStatus("unsupported_operation")).toBe(422);
    expect(completionErrorStatus("rate_limited")).toBe(429);
    expect(completionErrorStatus("psp_unavailable")).toBe(503);
    expect(completionErrorStatus("processing_error")).toBe(502);
    expect(completionErrorStatus("unknown")).toBe(500);
  });
});
