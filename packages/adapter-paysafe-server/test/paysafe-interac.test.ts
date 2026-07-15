import { describe, expect, it } from "vitest";
import { isPayFanoutError, type CreatePaymentSessionInput } from "@payfanout/core";
import {
  decodeSessionContext,
  PaysafeServerAdapter,
  type PaysafeServerAdapterConfig,
} from "../src/index.js";
import { FakePaysafeApi } from "./fake-paysafe-api.js";

const SIGNING_KEY = "session-signing-key";

function makePair(config: Partial<PaysafeServerAdapterConfig> = {}): {
  adapter: PaysafeServerAdapter;
  fake: FakePaysafeApi;
} {
  const fake = new FakePaysafeApi();
  const adapter = new PaysafeServerAdapter({
    username: "api_user",
    password: "api_pass",
    environment: "sandbox",
    merchantAccountResolver: (currency) => `acct-${currency}`,
    sessionSigningKey: SIGNING_KEY,
    webhookHmacKey: "webhook-hmac-key",
    fetch: fake.fetch,
    ...config,
  });
  return { adapter, fake };
}

const interacInput: CreatePaymentSessionInput = {
  amount: 5_44,
  currency: "CAD",
  country: "CA",
  paymentMethodTypes: ["interac_etransfer"],
  returnUrl: "https://shop.example/return",
  receiptEmail: "payer@example.com",
  idempotencyKey: "k-interac",
};

describe("Paysafe Interac e-Transfer sessions", () => {
  it("mints a payment handle and surfaces the redirect link the customer must follow", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({ ...interacInput });

    expect(fake.uniqueHandleCreations).toBe(1);
    expect(fake.lastRequestBody).toMatchObject({
      merchantRefNum: "k-interac",
      transactionType: "PAYMENT",
      paymentType: "INTERAC_ETRANSFER",
      amount: 5_44,
      currencyCode: "CAD",
      interacEtransfer: { consumerId: "payer@example.com", type: "EMAIL" },
    });
    // The handle exists; only the customer's authentication is outstanding.
    expect(session.status).toBe("requires_action");

    const context = await decodeSessionContext(session.pspSessionId, SIGNING_KEY);
    expect(context.paymentType).toBe("INTERAC_ETRANSFER");
    expect(context.paymentHandleToken).toBeTruthy();
    expect(context.redirectUrl).toContain("/alternatepayments/v1/redirect");
  });

  it("points every returnLinks rel at the host's returnUrl, marked so the client can spot the return", async () => {
    const { adapter, fake } = makePair();
    await adapter.createPaymentSession({ ...interacInput });
    const marked = "https://shop.example/return?payfanout_psp=paysafe";
    expect(fake.lastRequestBody?.["returnLinks"]).toEqual([
      { rel: "default", href: marked },
      { rel: "on_failed", href: marked },
      { rel: "on_cancelled", href: marked },
    ]);
  });

  it("preserves the host's own query parameters on the return URL", async () => {
    const { adapter, fake } = makePair();
    await adapter.createPaymentSession({
      ...interacInput,
      returnUrl: "https://shop.example/return?order=42",
    });
    const links = fake.lastRequestBody?.["returnLinks"] as Array<{ href: string }>;
    expect(links[0]!.href).toBe("https://shop.example/return?order=42&payfanout_psp=paysafe");
  });

  it("accepts billingDetails.email as the consumer alias when no receiptEmail is given", async () => {
    const { adapter, fake } = makePair();
    await adapter.createPaymentSession({
      ...interacInput,
      receiptEmail: undefined,
      billingDetails: { email: "billing@example.com" },
    });
    expect(fake.lastRequestBody?.["interacEtransfer"]).toEqual({
      consumerId: "billing@example.com",
      type: "EMAIL",
    });
  });

  it("charges the context's handle token, ignoring whatever clientToken rode the wire", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession({ ...interacInput });
    const context = await decodeSessionContext(session.pspSessionId, SIGNING_KEY);

    // The redirect rail never produces a real clientToken — the return trip
    // resolves with a placeholder so the standard completion route fires. The
    // signed context is the only authority on which handle gets charged, so a
    // tampered wire value must not reach Paysafe either.
    const info = await adapter.completePayment({
      pspSessionId: session.pspSessionId,
      clientToken: "paysafe-redirect-return",
      idempotencyKey: "k-complete",
    });

    expect(fake.lastRequestBody?.["paymentHandleToken"]).toBe(context.paymentHandleToken);
    expect(info.paymentMethodType).toBe("interac_etransfer");
    // Bank rails settle later: the terminal outcome arrives by webhook.
    expect(info.status).toBe("processing");
    expect(info.amount).toBe(5_44);
    expect(info.currency).toBe("CAD");
  });

  it("reports an in-flight debit as neither refunded nor captured", async () => {
    const { adapter } = makePair();
    const session = await adapter.createPaymentSession({ ...interacInput });
    const completed = await adapter.completePayment({
      pspSessionId: session.pspSessionId,
      clientToken: "",
      idempotencyKey: "k-complete",
    });
    // Reconciliation re-reads the payment, which resolves the PROCESSING
    // settlement Paysafe attaches immediately (availableToRefund: 0 there means
    // "not refundable yet" — reading it as a refund would tell the host the
    // customer had been paid back).
    const info = await adapter.retrievePayment(completed.pspPaymentId);
    expect(info.paymentMethodType).toBe("interac_etransfer");
    expect(info.status).toBe("processing");
    expect(info.amountRefunded).toBe(0);
    expect(info.amountCaptured).toBeUndefined();
    expect(info.capturedAt).toBeUndefined();
    expect(info.amount).toBe(5_44);
  });

  it("refuses to amend a session whose handle is already minted", async () => {
    const { adapter } = makePair();
    const session = await adapter.createPaymentSession({ ...interacInput });
    // The customer authorizes the handle's amount at their bank — re-signing a
    // context around it would charge an amount they never approved.
    await expect(
      adapter.updatePaymentSession({
        pspSessionId: session.pspSessionId,
        amount: 99_99,
        idempotencyKey: "k-update",
      }),
    ).rejects.toThrow(/already minted/);
  });

  it("dedupes handle creation on merchantRefNum, like the real API", async () => {
    const { adapter, fake } = makePair();
    await adapter.createPaymentSession({ ...interacInput });
    await adapter.createPaymentSession({ ...interacInput });
    expect(fake.uniqueHandleCreations).toBe(1);
  });

  it("models the rail honestly: redirect flow, and off until the account opts in", () => {
    const { adapter } = makePair();
    const interac = adapter
      .getCapabilities()
      .paymentMethods.find((m) => m.type === "interac_etransfer");
    // Implemented, but Canada/CAD and per-account — claiming it by default would
    // misreport every non-Canadian account.
    expect(interac).toEqual({ type: "interac_etransfer", flow: "redirect", supported: false });
  });

  it("serves accounts that opt the rail in", async () => {
    const { adapter, fake } = makePair({
      paymentMethods: [{ type: "interac_etransfer", flow: "redirect", supported: true }],
    });
    await adapter.createPaymentSession({ ...interacInput });
    expect(fake.uniqueHandleCreations).toBe(1);
  });
});

describe("Paysafe Interac e-Transfer guards", () => {
  const rejects = async (
    input: Partial<CreatePaymentSessionInput>,
    expected: RegExp,
  ): Promise<void> => {
    const { adapter, fake } = makePair();
    await expect(
      adapter.createPaymentSession({ ...interacInput, ...input }),
    ).rejects.toThrow(expected);
    // A rejected session must never have reached Paysafe.
    expect(fake.uniqueHandleCreations).toBe(0);
  };

  it("rejects a non-CAD session", async () => {
    await rejects({ currency: "USD" }, /CAD only/);
  });

  it("rejects manual capture — the rail cannot authorize without settling", async () => {
    await rejects({ captureMethod: "manual" }, /captureMethod/);
  });

  it("rejects a missing returnUrl", async () => {
    await rejects({ returnUrl: undefined }, /returnUrl/);
  });

  it("rejects a session with no customer email to collect from", async () => {
    await rejects({ receiptEmail: undefined }, /email/);
  });

  it("rejects a returnUrl that is not an absolute URL", async () => {
    await rejects({ returnUrl: "/return" }, /absolute URL/);
  });

  it("rejects mixing the redirect rail with card in one session", async () => {
    await rejects(
      { paymentMethodTypes: ["interac_etransfer", "card"] },
      /session of its own/,
    );
  });

  it("surfaces a missing redirect link as a PayFanout error rather than a bad session", async () => {
    const { adapter } = makePair({
      fetch: (async (input) => {
        const url = typeof input === "string" ? input : (input as Request).url;
        if (url.endsWith("/paymenthandles")) {
          return new Response(
            JSON.stringify({ id: "ph_1", paymentHandleToken: "PH1", status: "INITIATED", links: [] }),
            { status: 201, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });
    await expect(adapter.createPaymentSession({ ...interacInput })).rejects.toSatisfy(
      (err: unknown) => isPayFanoutError(err) && err.code === "processing_error",
    );
  });
});
