import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getCurrencyExponent, isPayFanoutError, utf8ToBase64Url, type PayFanoutError } from "@payfanout/core";
import {
  encodeSessionContext,
  parsePaysafeWebhookEvent,
  PaysafeServerAdapter,
  type PaysafeSessionContextV1,
  type PaysafeServerAdapterConfig,
} from "../src/index.js";
import { FakePaysafeApi, SEEDED_MULTI_USE_TOKEN } from "./fake-paysafe-api.js";

/**
 * Paysafe's amounts are "in minor units" of its Currency Codes table, which
 * gives CLP the exponent 2 where ISO 4217 gives 0, gives BYR 0 where core
 * reads 2, and omits ISK, one of the card processing currencies. Core's minor
 * units follow ISO 4217, so the adapter sends and reports no amount in a
 * currency whose exponents differ.
 */

const SIGNING_KEY = "session-signing-key";
const WEBHOOK_KEY = "webhook-hmac-key";
const API = "https://api.test.paysafe.com";

/**
 * The Currency Codes table as Paysafe publishes it (code:exponent), read
 * 2026-09-26 from developer.paysafe.com/en/support/reference-information/codes/#currency-codes.
 */
const PAYSAFE_TABLE: ReadonlyArray<[string, number]> = (
  "ARS:2 AUD:2 AZN:2 BHD:3 BYR:0 BOB:2 BAM:2 BRL:2 BGN:2 CAD:2 CLP:2 CNY:2 COP:2 CRC:2 HRK:2 CZK:2 " +
  "DKK:2 DOP:2 XCD:2 EGP:2 ETB:2 EUR:2 FJD:2 GEL:2 GTQ:2 HTG:2 HNL:2 HKD:2 HUF:2 INR:2 IDR:2 JMD:2 " +
  "JPY:0 JOD:3 KZT:2 KES:2 KRW:0 KWD:3 LVL:2 LBP:2 LYD:3 MWK:2 MUR:2 MXN:2 MDL:2 MAD:2 ILS:2 NZD:2 " +
  "NGN:2 NOK:2 OMR:3 PKR:2 PAB:2 PYG:0 PEN:2 PHP:2 PLN:2 GBP:2 QAR:2 RON:2 RUB:2 RWF:0 SAR:2 RSD:2 " +
  "SGD:2 ZAR:2 LKR:2 SEK:2 CHF:2 SYP:2 TWD:2 THB:2 TTD:2 TND:3 TRY:2 UAH:2 AED:2 UYU:2 USD:2 VEF:2 " +
  "VND:0"
)
  .split(" ")
  .map((entry) => {
    const [code, exponent] = entry.split(":");
    return [code!, Number(exponent)];
  });

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
    webhookHmacKey: WEBHOOK_KEY,
    fetch: fake.fetch,
    sleep: async () => undefined,
    ...config,
  });
  return { adapter, fake };
}

async function rejection(promise: Promise<unknown>): Promise<PayFanoutError> {
  try {
    await promise;
  } catch (err) {
    if (isPayFanoutError(err)) return err;
    throw err;
  }
  throw new Error("expected the call to reject");
}

/** A request straight to the fake, as another integration on the account would send it. */
async function paysafeCall<T>(fake: FakePaysafeApi, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const response = await fake.fetch(`${API}${path}`, {
    method,
    headers: { authorization: "Basic legacy" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return (await response.json()) as T;
}

/** A payment an earlier release, or another integration, made in `currencyCode`. */
async function paymentMadeElsewhere(
  fake: FakePaysafeApi,
  currencyCode: string,
  settleWithAuth: boolean,
): Promise<{ id: string; merchantRefNum: string }> {
  const merchantRefNum = `elsewhere-${currencyCode}-${settleWithAuth ? "auto" : "manual"}`;
  const payment = await paysafeCall<{ id: string }>(fake, "POST", "/paymenthub/v1/payments", {
    merchantRefNum,
    dupCheck: false,
    amount: 1_000_000,
    currencyCode,
    paymentHandleToken: `tok_${merchantRefNum}`,
    settleWithAuth,
  });
  return { id: payment.id, merchantRefNum };
}

/** A scheduler subscription billing in `currencyCode`, created outside the adapter. */
async function subscriptionMadeElsewhere(fake: FakePaysafeApi, currencyCode: string): Promise<string> {
  const plan = await paysafeCall<{ id: string }>(fake, "POST", "/subscriptionsplans/v1/plans", {
    name: `plan in ${currencyCode}`,
    amount: 1_000_000,
    currencyCode,
    billingCycle: { frequency: "MONTHLY", interval: 1, numberOfCycles: 0 },
    status: "ACTIVE",
  });
  const sub = await paysafeCall<{ id: string }>(fake, "POST", `/subscriptionsplans/v1/plans/${plan.id}/subscriptions`, {
    merchantRefNum: `sub-${currencyCode}`,
    paymentHandleToken: SEEDED_MULTI_USE_TOKEN,
    status: "ACTIVE",
  });
  return sub.id;
}

function sentSince(fake: FakePaysafeApi, before: number): string[] {
  return fake.requests.slice(before).map((r) => `${r.method} ${r.path}`);
}

function context(currency: string, extra: Partial<PaysafeSessionContextV1> = {}): Promise<string> {
  return encodeSessionContext(
    { v: 1, amount: 10_000, currency, captureMethod: "automatic", expiresAt: Date.now() + 60_000, ...extra },
    SIGNING_KEY,
  );
}

/** A delivery's raw body in the documented envelope; ids and values are made up. */
function webhookIn(currencyCode: string, eventName = "PAYMENT_COMPLETED"): string {
  return JSON.stringify({
    payload: {
      accountId: "1001234567",
      id: "0f3a6c1e-5b2d-4e8f-9a7c-3d1e2f4a5b6c",
      merchantRefNum: "order-cur-1",
      amount: 1_000_000,
      currencyCode,
      status: "COMPLETED",
      txnTime: "2026-09-26T10:00:02Z",
    },
    attemptNumber: "1",
    type: eventName.startsWith("REFUND") ? "REFUND" : "PAYMENT",
    eventDate: "2026-09-26T10:00:02Z",
    eventName,
  });
}

describe("currencies whose Paysafe exponent is not the ISO 4217 one", () => {
  it("refuses a session in each currency Paysafe's table prices off ISO 4217, and in ISK, which it omits", async () => {
    const { adapter } = makePair();
    const refused: string[] = [];
    for (const [currency, paysafeExponent] of [...PAYSAFE_TABLE, ["ISK", undefined] as const]) {
      const created = adapter.createPaymentSession({ amount: 1000, currency, idempotencyKey: `k-${currency}` });
      if (paysafeExponent === getCurrencyExponent(currency)) {
        await expect(created, currency).resolves.toMatchObject({ amount: 1000, currency });
      } else {
        const err = await rejection(created);
        expect(err, currency).toMatchObject({ code: "invalid_request", retryable: false, pspName: "paysafe" });
        refused.push(currency);
      }
    }
    expect(refused.sort()).toEqual(["BYR", "CLP", "ISK"]);
  });

  it("names Paysafe's exponent and ISO's, and says the adapter does not convert", async () => {
    const { adapter } = makePair();
    const clp = await rejection(adapter.createPaymentSession({ amount: 10_000, currency: " clp ", idempotencyKey: "k" }));
    expect(clp.message).toMatch(/exponent 2/);
    expect(clp.message).toMatch(/exponent 0/);
    expect(clp.message).toMatch(/does not convert/);
    expect(clp.raw).toEqual({ currency: "CLP", paysafeExponent: 2, isoExponent: 0 });
    const isk = await rejection(adapter.createPaymentSession({ amount: 10_000, currency: "ISK", idempotencyKey: "k" }));
    expect(isk.message).toMatch(/documents no exponent for ISK/);
    expect(isk.message).toMatch(/exponent 0/);
    expect(isk.raw).toEqual({ currency: "ISK", isoExponent: 0 });
    const byr = await rejection(adapter.createPaymentSession({ amount: 10_000, currency: "BYR", idempotencyKey: "k" }));
    expect(byr.raw).toEqual({ currency: "BYR", paysafeExponent: 0, isoExponent: 2 });
  });

  it("refuses them on a bank-debit session too, which carries no currency gate of its own", async () => {
    const { adapter } = makePair();
    await expect(
      adapter.createPaymentSession({ amount: 10_000, currency: "CLP", paymentMethodTypes: ["ach"], idempotencyKey: "k" }),
    ).rejects.toMatchObject({ code: "invalid_request", message: expect.stringMatching(/does not convert/) });
  });

  it("refuses an update into one, and any update of a session signed in one", async () => {
    const { adapter } = makePair();
    const session = await adapter.createPaymentSession({ amount: 10_000, currency: "USD", idempotencyKey: "k" });
    await expect(
      adapter.updatePaymentSession({ pspSessionId: session.pspSessionId, currency: "CLP", idempotencyKey: "u1" }),
    ).rejects.toMatchObject({ code: "invalid_request", message: expect.stringMatching(/does not convert/) });
    await expect(
      adapter.updatePaymentSession({ pspSessionId: await context("ISK"), amount: 5000, idempotencyKey: "u2" }),
    ).rejects.toMatchObject({ code: "invalid_request", message: expect.stringMatching(/ISK/) });
  });

  it("refuses to complete a session signed in one before any request, on the card and bank-debit paths", async () => {
    const { adapter, fake } = makePair();
    await expect(
      adapter.completePayment({ pspSessionId: await context("CLP"), clientToken: "tok_clp", idempotencyKey: "c1" }),
    ).rejects.toMatchObject({ code: "invalid_request", message: expect.stringMatching(/does not convert/) });
    const achEnvelope = `paysafe-bank.${utf8ToBase64Url(
      JSON.stringify({
        v: 1,
        paymentType: "ACH",
        accountHolderName: "Pat Doe",
        routingNumber: "123456789",
        accountNumber: "1234567890",
      }),
    )}`;
    await expect(
      adapter.completePayment({
        pspSessionId: await context("CLP", { paymentType: "ACH" }),
        clientToken: achEnvelope,
        idempotencyKey: "c2",
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(fake.requests).toEqual([]);
  });

  it("refuses a saved-method charge and a native subscription in one before any request", async () => {
    const { adapter, fake } = makePair();
    await expect(
      adapter.chargeSavedPaymentMethod({
        pspCustomerId: "cust_1",
        savedPaymentMethodToken: SEEDED_MULTI_USE_TOKEN,
        amount: 10_000,
        currency: "CLP",
        idempotencyKey: "charge-1",
      }),
    ).rejects.toMatchObject({ code: "invalid_request", message: expect.stringMatching(/does not convert/) });
    await expect(
      adapter.createNativeSubscription({
        savedPaymentMethodToken: SEEDED_MULTI_USE_TOKEN,
        amount: 10_000,
        currency: "ISK",
        interval: "month",
        idempotencyKey: "sub-1",
      }),
    ).rejects.toMatchObject({ code: "invalid_request", message: expect.stringMatching(/ISK/) });
    await expect(
      adapter.createNativeSubscription({
        savedPaymentMethodToken: SEEDED_MULTI_USE_TOKEN,
        amount: 10_000,
        currency: "CLP",
        interval: "month",
        planId: "plan_host_managed",
        idempotencyKey: "sub-2",
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(fake.requests).toEqual([]);
  });

  it("refuses to capture, void or refund a payment Paysafe reports in one, once read and before anything else", async () => {
    const { adapter, fake } = makePair();
    const authorized = await paymentMadeElsewhere(fake, "CLP", false);
    const settled = await paymentMadeElsewhere(fake, "CLP", true);
    const calls: Array<[string, string, () => Promise<unknown>]> = [
      ["Capture", authorized.id, () => adapter.capturePayment(authorized.id, undefined, "cap-1")],
      ["Capture", authorized.id, () => adapter.capturePayment(authorized.id, 500_000, "cap-2")],
      ["Void", authorized.id, () => adapter.cancelPayment(authorized.id, "void-1")],
      ["Refund", settled.id, () => adapter.refundPayment({ pspPaymentId: settled.id, idempotencyKey: "ref-1" })],
      ["Refund", settled.id, () => adapter.refundPayment({ pspPaymentId: settled.id, amount: 100, idempotencyKey: "ref-2" })],
    ];
    for (const [action, id, call] of calls) {
      const before = fake.requests.length;
      const err = await rejection(call());
      expect(err, action).toMatchObject({ code: "invalid_request", retryable: false, pspName: "paysafe" });
      expect(err.message).toContain(`Payment ${id} is in CLP`);
      expect(err.message).toContain(`${action} it in the Paysafe portal`);
      expect(sentSince(fake, before)).toEqual([`GET /paymenthub/v1/payments/${id}`]);
    }
    expect(fake.uniqueSettlementCreations).toBe(0);
    expect(fake.uniqueRefundCreations).toBe(0);
  });

  it("refuses to report a payment or a refund in one", async () => {
    const { adapter, fake } = makePair();
    const settled = await paymentMadeElsewhere(fake, "CLP", true);
    const before = fake.requests.length;
    const read = await rejection(adapter.retrievePayment(settled.id));
    expect(read).toMatchObject({ code: "unsupported_operation", retryable: false, pspName: "paysafe" });
    expect(read.message).toMatch(/cannot be reported in ISO 4217 minor units/);
    expect(read.message).toMatch(/Read it in the Paysafe portal/);
    // No settlement lookup follows: the read stops at the payment.
    expect(sentSince(fake, before)).toEqual([`GET /paymenthub/v1/payments/${settled.id}`]);

    const lookup = await paysafeCall<{ settlements: Array<{ id: string }> }>(
      fake,
      "GET",
      `/paymenthub/v1/settlements?merchantRefNum=${settled.merchantRefNum}`,
    );
    const refund = await paysafeCall<{ id: string }>(
      fake,
      "POST",
      `/paymenthub/v1/settlements/${lookup.settlements[0]!.id}/refunds`,
      { merchantRefNum: "refund-elsewhere", amount: 100_000 },
    );
    await expect(adapter.retrieveRefund(refund.id)).rejects.toMatchObject({
      code: "unsupported_operation",
      message: expect.stringMatching(/Refund .* is in CLP/),
    });
  });

  it("refuses to report a subscription billing in one, or to cancel it", async () => {
    const { adapter, fake } = makePair();
    await adapter.createNativeSubscription({
      savedPaymentMethodToken: SEEDED_MULTI_USE_TOKEN,
      amount: 1499,
      currency: "USD",
      interval: "month",
      idempotencyKey: "sub-usd",
    });
    const subscriptionId = await subscriptionMadeElsewhere(fake, "CLP");
    const inIsk = await subscriptionMadeElsewhere(fake, "ISK");
    await expect(adapter.retrieveNativeSubscription({ subscriptionId })).rejects.toMatchObject({
      code: "unsupported_operation",
      message: expect.stringMatching(/cannot be reported in ISO 4217 minor units/),
    });
    // The page fails whole, naming each subscription it cannot report.
    const listed = await rejection(adapter.listNativeSubscriptions({ limit: 50 }));
    expect(listed).toMatchObject({ code: "unsupported_operation", retryable: false });
    expect(listed.message).toContain(`${subscriptionId} in CLP, ${inIsk} in ISK`);
    expect(listed.message).toMatch(/Paysafe documents no exponent for ISK/);
    const before = fake.requests.length;
    const cancel = await rejection(adapter.cancelNativeSubscription({ subscriptionId, idempotencyKey: "cancel-1" }));
    expect(cancel).toMatchObject({ code: "unsupported_operation", message: expect.stringMatching(/Cancel it in the Paysafe portal/) });
    expect(sentSince(fake, before)).not.toContain(`PATCH /subscriptionsplans/v1/subscriptions/${subscriptionId}`);
  });

  it("reports a webhook in one without its amount, and everything else as it would for any currency", async () => {
    const { adapter } = makePair();
    for (const parse of [(raw: string) => adapter.parseWebhookEvent(raw), parsePaysafeWebhookEvent]) {
      const usd = await parse(webhookIn("USD"));
      expect(usd.amount).toBe(1_000_000);
      for (const currency of ["CLP", "isk", "BYR"]) {
        const event = await parse(webhookIn(currency));
        expect(event, currency).not.toHaveProperty("amount");
        expect(event).toMatchObject({
          id: usd.id,
          type: "payment.succeeded",
          pspPaymentId: usd.pspPaymentId,
          currency: currency.toUpperCase(),
          occurredAt: usd.occurredAt,
        });
      }
      const refund = await parse(webhookIn("CLP", "REFUND_COMPLETED"));
      expect(refund).not.toHaveProperty("amount");
      expect(refund).toMatchObject({ type: "payment.refunded", refundId: "0f3a6c1e-5b2d-4e8f-9a7c-3d1e2f4a5b6c" });
    }
    // Verification still runs over the delivered bytes.
    const raw = webhookIn("CLP");
    const signature = createHmac("sha256", WEBHOOK_KEY).update(raw, "utf8").digest("base64");
    await expect(adapter.verifyWebhookSignature(raw, { Signature: signature })).resolves.toBe(true);
  });
});

describe("currencies Paysafe prices as ISO 4217 does", () => {
  const cases: Array<[string, number, number]> = [
    ["JPY", 5000, 1000],
    ["KWD", 1234, 234],
    ["USD", 1099, 99],
  ];
  for (const [currency, amount, partial] of cases) {
    it(`sends and reports ${currency} amounts unchanged, in ISO 4217 minor units`, async () => {
      const { adapter, fake } = makePair();
      const session = await adapter.createPaymentSession({ amount, currency, idempotencyKey: `${currency}-s` });
      const paid = await adapter.completePayment({
        pspSessionId: session.pspSessionId,
        clientToken: `tok_${currency}`,
        idempotencyKey: `${currency}-c`,
      });
      expect(fake.lastRequestBody).toMatchObject({ amount, currencyCode: currency });
      expect(paid).toMatchObject({ amount, currency, amountCaptured: amount });
      await expect(adapter.retrievePayment(paid.pspPaymentId)).resolves.toMatchObject({ amount, currency });

      const refund = await adapter.refundPayment({ pspPaymentId: paid.pspPaymentId, amount: partial, idempotencyKey: `${currency}-r` });
      expect(fake.lastRequestBody).toMatchObject({ amount: partial });
      expect(refund.amount).toBe(partial);
      await expect(adapter.retrieveRefund(refund.refundId)).resolves.toMatchObject({ amount: partial });

      const manual = await adapter.createPaymentSession({ amount, currency, captureMethod: "manual", idempotencyKey: `${currency}-ms` });
      const authorized = await adapter.completePayment({
        pspSessionId: manual.pspSessionId,
        clientToken: `tok_${currency}_manual`,
        idempotencyKey: `${currency}-mc`,
      });
      const captured = await adapter.capturePayment(authorized.pspPaymentId, undefined, `${currency}-cap`);
      expect(fake.requestsTo("POST", `/paymenthub/v1/payments/${authorized.pspPaymentId}/settlements`)[0]!.body).toMatchObject({ amount });
      expect(captured).toMatchObject({ amountCaptured: amount, currency });

      await adapter.chargeSavedPaymentMethod({
        pspCustomerId: "cust_1",
        savedPaymentMethodToken: SEEDED_MULTI_USE_TOKEN,
        amount,
        currency,
        idempotencyKey: `${currency}-charge`,
      });
      expect(fake.lastRequestBody).toMatchObject({ amount, currencyCode: currency });

      const subscription = await adapter.createNativeSubscription({
        savedPaymentMethodToken: SEEDED_MULTI_USE_TOKEN,
        amount,
        currency,
        interval: "month",
        idempotencyKey: `${currency}-sub`,
      });
      expect(fake.lastPlanRequestBody).toMatchObject({ amount, currencyCode: currency });
      expect(subscription).toMatchObject({ amount, currency });

      await expect(adapter.parseWebhookEvent(webhookIn(currency))).resolves.toMatchObject({ amount: 1_000_000, currency });
    });
  }
});
