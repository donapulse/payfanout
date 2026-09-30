import { describe, expect, it } from "vitest";
import { sha256Hex, type CreatePaymentSessionInput } from "@payfanout/core";
import { GoCardlessServerAdapter, type GoCardlessServerAdapterConfig } from "../src/index.js";
import { FakeGoCardlessApi } from "./fake-gocardless-api.js";

const WEBHOOK_SECRET = "fake-webhook-endpoint-secret";
const RETURN_URL = "https://merchant.example/return";

function makePair(config: Partial<GoCardlessServerAdapterConfig> = {}): {
  adapter: GoCardlessServerAdapter;
  fake: FakeGoCardlessApi;
} {
  const fake = new FakeGoCardlessApi();
  const adapter = new GoCardlessServerAdapter({
    accessToken: "fake-sandbox-access-token",
    environment: "sandbox",
    webhookSecret: WEBHOOK_SECRET,
    fetch: fake.fetch,
    sleep: async () => {},
    ...config,
  });
  return { adapter, fake };
}

let keys = 0;
const freshKey = (): string => `k-limits-${++keys}`;

function sessionInput(fields: Partial<CreatePaymentSessionInput> = {}): CreatePaymentSessionInput {
  return { amount: 1000, currency: "GBP", returnUrl: RETURN_URL, idempotencyKey: freshKey(), ...fields };
}

async function confirmedPayment(adapter: GoCardlessServerAdapter, fake: FakeGoCardlessApi): Promise<string> {
  const session = await adapter.createPaymentSession(sessionInput());
  const { paymentId } = fake.fulfilBillingRequest(session.pspSessionId);
  fake.confirmPayment(paymentId);
  return paymentId;
}

/** The body of the latest create sent to `path`, under its envelope. */
function lastCreate(fake: FakeGoCardlessApi, path: string, envelope: string): Record<string, unknown> {
  return fake.requestsTo("POST", path).at(-1)?.body?.[envelope] as Record<string, unknown>;
}

/** The metadata the latest billing request create sent, on the request and on its payment_request. */
function sentSessionMetadata(fake: FakeGoCardlessApi): { request: unknown; payment: unknown } {
  const body = lastCreate(fake, "/billing_requests", "billing_requests") as {
    metadata?: unknown;
    payment_request?: { metadata?: unknown };
  };
  return { request: body.metadata, payment: body.payment_request?.metadata };
}

describe("GoCardless metadata limits", () => {
  const name50 = "k".repeat(50);
  const name51 = "k".repeat(51);
  const value500 = "v".repeat(500);
  const value501 = "v".repeat(501);

  it("sends 50-character key names and 500-character values unchanged, on the request and its payment", async () => {
    const { adapter, fake } = makePair();
    const id = "i".repeat(500);
    await adapter.createPaymentSession(sessionInput({ id, metadata: { [name50]: value500 } }));
    const expected = { payfanout_id: id, [name50]: value500 };
    expect(sentSessionMetadata(fake)).toEqual({ request: expected, payment: expected });
  });

  it("refuses a key name over 50 characters before any request, naming it", async () => {
    const { adapter, fake } = makePair();
    await expect(adapter.createPaymentSession(sessionInput({ metadata: { [name51]: "v" } }))).rejects.toMatchObject({
      code: "invalid_request",
      retryable: false,
      message: `GoCardless metadata key names are at most 50 characters; "${name51}" has 51`,
      raw: { key: name51, characters: 51, limit: 50 },
    });
    expect(fake.requests).toHaveLength(0);
  });

  it("refuses a value over 500 characters before any request, naming its key", async () => {
    const { adapter, fake } = makePair();
    await expect(
      adapter.createPaymentSession(sessionInput({ metadata: { plan: "pro", note: value501 } })),
    ).rejects.toMatchObject({
      code: "invalid_request",
      retryable: false,
      message: 'GoCardless metadata values are at most 500 characters; the value of "note" has 501',
      raw: { key: "note", characters: 501, limit: 500 },
    });
    expect(fake.requests).toHaveLength(0);
  });

  it("refuses an id over 500 characters, which rides payfanout_id", async () => {
    const { adapter, fake } = makePair();
    await expect(adapter.createPaymentSession(sessionInput({ id: "i".repeat(501) }))).rejects.toMatchObject({
      code: "invalid_request",
      message: 'GoCardless metadata values are at most 500 characters; the value of "payfanout_id" has 501',
    });
    expect(fake.requests).toHaveLength(0);
  });

  it("counts code points, so characters outside the Basic Multilingual Plane count once", async () => {
    const { adapter, fake } = makePair();
    const name = "\u{1F511}".repeat(50);
    const value = "\u{1F600}".repeat(500);
    expect([name.length, value.length]).toEqual([100, 1000]);
    await adapter.createPaymentSession(sessionInput({ metadata: { [name]: value } }));
    expect(sentSessionMetadata(fake).request).toEqual({ [name]: value });

    const sent = fake.requests.length;
    await expect(
      adapter.createPaymentSession(sessionInput({ metadata: { note: `${value}\u{1F600}` } })),
    ).rejects.toMatchObject({ raw: { key: "note", characters: 501, limit: 500 } });
    expect(fake.requests).toHaveLength(sent);
  });

  it("leaves a value that is not a string to GoCardless, as before", async () => {
    const { adapter, fake } = makePair();
    await adapter.createPaymentSession(sessionInput({ metadata: { seats: 3 as never } }));
    expect(sentSessionMetadata(fake).request).toEqual({ seats: 3 });
  });

  it("measures a value that is not a string by the JSON it goes out as", async () => {
    const { adapter, fake } = makePair();
    const sent = fake.requests.length;
    await expect(
      adapter.createPaymentSession(sessionInput({ metadata: { tags: ["x".repeat(500)] as never } })),
    ).rejects.toMatchObject({ code: "invalid_request", raw: { key: "tags", characters: 504, limit: 500 } });
    expect(fake.requests).toHaveLength(sent);
  });

  it("sends host keys that name an object's own properties, such as constructor, like any other key", async () => {
    const { adapter, fake } = makePair();
    // JSON.parse makes "__proto__" an own key, as a host's parsed input would.
    const metadata = JSON.parse('{"constructor":"c","__proto__":"p","toString":"t"}') as Record<string, string>;
    await adapter.createPaymentSession(sessionInput({ metadata }));
    expect(sentSessionMetadata(fake).request).toEqual(JSON.parse('{"constructor":"c","__proto__":"p","toString":"t"}'));
  });

  it("still withholds keys past the third, checking only the keys it sends", async () => {
    const { adapter, fake } = makePair();
    // Without an id three host keys fit; a fourth is withheld, whatever it holds.
    await adapter.createPaymentSession(sessionInput({ metadata: { a: "1", b: "2", c: "3", [name51]: value501 } }));
    expect(sentSessionMetadata(fake).request).toEqual({ a: "1", b: "2", c: "3" });
    // With an id, payfanout_id takes the first slot and the third host key is withheld.
    await adapter.createPaymentSession(sessionInput({ id: "order-1", metadata: { a: "1", b: "2", c: value501 } }));
    expect(sentSessionMetadata(fake).request).toEqual({ payfanout_id: "order-1", a: "1", b: "2" });
  });

  it("applies the same limits to subscription metadata, before any request", async () => {
    const { adapter, fake } = makePair();
    const input = (fields: { id?: string; metadata?: Record<string, string> }) => ({
      savedPaymentMethodToken: fake.seedMandate().id,
      amount: 1000,
      currency: "GBP",
      interval: "month" as const,
      idempotencyKey: freshKey(),
      ...fields,
    });
    await adapter.createNativeSubscription(input({ id: "i".repeat(500), metadata: { [name50]: value500 } }));
    expect(lastCreate(fake, "/subscriptions", "subscriptions")["metadata"]).toEqual({
      payfanout_id: "i".repeat(500),
      [name50]: value500,
    });

    const sent = fake.requests.length;
    await expect(adapter.createNativeSubscription(input({ metadata: { [name51]: "v" } }))).rejects.toMatchObject({
      code: "invalid_request",
      raw: { key: name51, characters: 51, limit: 50 },
    });
    await expect(adapter.createNativeSubscription(input({ metadata: { note: value501 } }))).rejects.toMatchObject({
      code: "invalid_request",
      raw: { key: "note", characters: 501, limit: 500 },
    });
    await expect(adapter.createNativeSubscription(input({ id: "i".repeat(501) }))).rejects.toMatchObject({
      code: "invalid_request",
      raw: { key: "payfanout_id", characters: 501, limit: 500 },
    });
    expect(fake.requests).toHaveLength(sent);
  });

  it("refuses a refund reason its metadata cannot hold, before any request", async () => {
    const { adapter, fake } = makePair();
    const paymentId = await confirmedPayment(adapter, fake);
    const sent = fake.requests.length;
    await expect(
      adapter.refundPayment({ pspPaymentId: paymentId, reason: value501 as never, idempotencyKey: freshKey() }),
    ).rejects.toMatchObject({
      code: "invalid_request",
      retryable: false,
      message: 'GoCardless metadata values are at most 500 characters; the value of "reason" has 501',
    });
    expect(fake.requests).toHaveLength(sent);

    await adapter.refundPayment({ pspPaymentId: paymentId, reason: value500 as never, idempotencyKey: freshKey() });
    expect((lastCreate(fake, "/refunds", "refunds")["metadata"] as Record<string, string>)["reason"]).toBe(value500);
  });
});

describe("GoCardless idempotency keys", () => {
  const key128 = "k".repeat(128);
  const key129 = "k".repeat(129);

  // Each case sets up its resource and returns the mutating call under test.
  const cases: Array<
    [string, (adapter: GoCardlessServerAdapter, fake: FakeGoCardlessApi) => Promise<(key: string) => Promise<unknown>>]
  > = [
    ["createPaymentSession", async (adapter) => (key) => adapter.createPaymentSession(sessionInput({ idempotencyKey: key }))],
    [
      "refundPayment",
      async (adapter, fake) => {
        const paymentId = await confirmedPayment(adapter, fake);
        return (key) => adapter.refundPayment({ pspPaymentId: paymentId, amount: 100, idempotencyKey: key });
      },
    ],
    [
      "cancelPayment of a billing request",
      async (adapter) => {
        const session = await adapter.createPaymentSession(sessionInput());
        return (key) => adapter.cancelPayment(session.pspSessionId, key);
      },
    ],
    [
      "cancelPayment of a payment",
      async (adapter, fake) => {
        const session = await adapter.createPaymentSession(sessionInput());
        const { paymentId } = fake.fulfilBillingRequest(session.pspSessionId);
        return (key) => adapter.cancelPayment(paymentId, key);
      },
    ],
    [
      "createNativeSubscription",
      async (adapter, fake) => {
        const mandate = fake.seedMandate();
        return (key) =>
          adapter.createNativeSubscription({
            savedPaymentMethodToken: mandate.id,
            amount: 1000,
            currency: "GBP",
            interval: "month",
            idempotencyKey: key,
          });
      },
    ],
    [
      "cancelNativeSubscription",
      async (adapter, fake) => {
        const subscription = fake.seedSubscription();
        return (key) => adapter.cancelNativeSubscription({ subscriptionId: subscription.id, idempotencyKey: key });
      },
    ],
  ];

  for (const [name, setUp] of cases) {
    it(`${name} sends a key over 128 characters as a digest of itself, and one of 128 as given`, async () => {
      const long = makePair();
      const callLong = await setUp(long.adapter, long.fake);
      const before = long.fake.idempotencyKeysSeen.length;
      await callLong(key129);
      const sent = long.fake.idempotencyKeysSeen.slice(before).map(({ key }) => key);
      expect(sent.length).toBeGreaterThan(0);
      expect(sent.every((key) => /^payfanout-sha256-[0-9a-f]{64}$/.test(key))).toBe(true);
      expect(sent).not.toContain(key129);
      const exact = makePair();
      const callExact = await setUp(exact.adapter, exact.fake);
      await callExact(key128);
      expect(exact.fake.idempotencyKeysSeen.map(({ key }) => key)).toContain(key128);
    });
  }

  it("sends a key fetch trims exactly as an earlier release sent it, so a replay across the upgrade replays", async () => {
    const { adapter, fake } = makePair();
    // fetch sent "order-42\n" as "order-42": the create an earlier release made under it is the one to meet.
    const first = await adapter.createPaymentSession(sessionInput({ idempotencyKey: "order-42" }));
    const again = await adapter.createPaymentSession(sessionInput({ idempotencyKey: "order-42\n" }));
    expect(again.pspSessionId).toBe(first.pspSessionId);
    expect(new Set(fake.idempotencyKeysSeen.map(({ key }) => key))).toEqual(new Set(["order-42"]));
    // 128 characters and a trailing space went out as the 128, which GoCardless takes.
    const long = "k".repeat(128);
    const third = await adapter.createPaymentSession(sessionInput({ idempotencyKey: long }));
    const fourth = await adapter.createPaymentSession(sessionInput({ idempotencyKey: `${long} ` }));
    expect(fourth.pspSessionId).toBe(third.pspSessionId);
  });

  for (const [name, setUp] of cases) {
    it(`${name} refuses a key holding a lone surrogate before any request`, async () => {
      const { adapter, fake } = makePair();
      const call = await setUp(adapter, fake);
      const sent = fake.requests.length;
      await expect(call("order-\uD800")).rejects.toMatchObject({
        code: "invalid_request",
        retryable: false,
        message: expect.stringMatching(/lone surrogate/),
      });
      expect(fake.requests).toHaveLength(sent);
    });
  }

  it("stamps a refund with the digest of the key as given, whatever header carries it, and replays it", async () => {
    const { adapter, fake } = makePair();
    const paymentId = await confirmedPayment(adapter, fake);
    const key = `refund-${"x".repeat(200)}`;
    const refund = await adapter.refundPayment({ pspPaymentId: paymentId, amount: 100, idempotencyKey: key });
    const created = lastCreate(fake, "/refunds", "refunds") as { metadata?: Record<string, string> };
    expect(created.metadata?.["payfanout_key_sha256"]).toBe(await sha256Hex(key));
    expect(fake.idempotencyKeysSeen.at(-1)?.key).toBe(`payfanout-sha256-${await sha256Hex(key)}`);
    const replay = await adapter.refundPayment({ pspPaymentId: paymentId, amount: 100, idempotencyKey: key });
    expect(replay.refundId).toBe(refund.refundId);
    expect(fake.requestsTo("POST", "/refunds")).toHaveLength(1);
  });

  it("replays a create under the same over-long key instead of creating it twice", async () => {
    const { adapter, fake } = makePair();
    const key = `order-${"x".repeat(200)}`;
    const first = await adapter.createPaymentSession(sessionInput({ idempotencyKey: key }));
    const again = await adapter.createPaymentSession(sessionInput({ idempotencyKey: key }));
    expect(again.pspSessionId).toBe(first.pspSessionId);
    const headers = new Set(fake.idempotencyKeysSeen.map(({ key: seen }) => seen));
    expect(headers.size).toBe(1);
  });

  it("sends a key no header can carry as its digest, instead of failing before the request", async () => {
    const { adapter, fake } = makePair();
    await expect(adapter.createPaymentSession(sessionInput({ idempotencyKey: "order-€-42" }))).resolves.toMatchObject({
      status: "requires_action",
    });
    expect(fake.idempotencyKeysSeen.at(-1)?.key).toMatch(/^payfanout-sha256-[0-9a-f]{64}$/);
  });

  it("leaves a missing key to the caller's contract instead of failing on it", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession(sessionInput());
    await expect(adapter.cancelPayment(session.pspSessionId, undefined as never)).resolves.toMatchObject({
      status: "canceled",
    });
    expect(fake.requests.at(-1)?.headers).not.toHaveProperty("idempotency-key");
  });
});

describe("GoCardless Accept header", () => {
  it("asks for JSON on every request: reads, lists, creates, actions and the connection check", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession(sessionInput());
    await adapter.retrievePayment(session.pspSessionId);
    const { paymentId } = fake.fulfilBillingRequest(session.pspSessionId);
    fake.confirmPayment(paymentId);
    await adapter.retrievePayment(paymentId);
    const refund = await adapter.refundPayment({ pspPaymentId: paymentId, amount: 100, idempotencyKey: freshKey() });
    await adapter.refundPayment({ pspPaymentId: paymentId, amount: 100, idempotencyKey: freshKey() });
    await adapter.retrieveRefund(refund.refundId);
    await adapter.listPayments({ limit: 1 });
    await adapter.listRefunds({ pspPaymentId: paymentId });
    await adapter.fetchEvents({ limit: 1 });
    const pending = await adapter.createPaymentSession(sessionInput());
    await adapter.cancelPayment(pending.pspSessionId, freshKey());
    const fulfilled = await adapter.createPaymentSession(sessionInput());
    await adapter.cancelPayment(fake.fulfilBillingRequest(fulfilled.pspSessionId).paymentId, freshKey());
    const subscription = await adapter.createNativeSubscription({
      savedPaymentMethodToken: fake.seedMandate().id,
      amount: 1000,
      currency: "GBP",
      interval: "month",
      idempotencyKey: freshKey(),
    });
    await adapter.retrieveNativeSubscription({ subscriptionId: subscription.id });
    await adapter.listNativeSubscriptions({ limit: 1 });
    await adapter.cancelNativeSubscription({ subscriptionId: subscription.id, idempotencyKey: freshKey() });
    await expect(adapter.verifyCredentials()).resolves.toEqual({ ok: true });

    const kinds = new Set(fake.requests.map(({ method, path }) => `${method} ${path.replace(/\/[A-Z]{2,3}\d+/g, "/:id")}`));
    expect([...kinds].sort()).toEqual([
      "GET /billing_requests/:id",
      "GET /events",
      "GET /mandates/:id",
      "GET /payments",
      "GET /payments/:id",
      "GET /refunds",
      "GET /refunds/:id",
      "GET /subscriptions",
      "GET /subscriptions/:id",
      "POST /billing_request_flows",
      "POST /billing_requests",
      "POST /billing_requests/:id/actions/cancel",
      "POST /payments/:id/actions/cancel",
      "POST /refunds",
      "POST /subscriptions",
      "POST /subscriptions/:id/actions/cancel",
    ]);
    // The connection check is the last request, and goes through its own path.
    expect(fake.requests.at(-1)).toMatchObject({ method: "GET", path: "/payments", headers: { accept: "application/json" } });
    expect(fake.requests.filter(({ headers }) => headers["accept"] !== "application/json")).toEqual([]);
  });
});

describe("GoCardless amounts read from the wire", () => {
  it("reads a payment's amounts sent as digit strings as numbers", async () => {
    const { adapter, fake } = makePair();
    const payment = fake.seedPayment();
    fake.setPaymentFields(payment.id, { amount: "1000", amount_refunded: "250" });
    await expect(adapter.retrievePayment(payment.id)).resolves.toMatchObject({ amount: 1000, amountRefunded: 250 });
    const { payments } = await adapter.listPayments();
    expect(payments.find(({ pspPaymentId }) => pspPaymentId === payment.id)).toMatchObject({
      amount: 1000,
      amountRefunded: 250,
    });
  });

  it("reads a billing request's amount sent as a digit string, before its payment exists", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession(sessionInput({ amount: 2599 }));
    fake.setBillingRequestFields(session.pspSessionId, {
      payment_request: { amount: "2599", currency: "GBP", description: "Payment" },
    });
    await expect(adapter.retrievePayment(session.pspSessionId)).resolves.toMatchObject({ amount: 2599 });
    await expect(adapter.cancelPayment(session.pspSessionId, freshKey())).resolves.toMatchObject({
      amount: 2599,
      status: "canceled",
    });
  });

  it("reads a refund's amount sent as a digit string", async () => {
    const { adapter, fake } = makePair();
    const paymentId = await confirmedPayment(adapter, fake);
    const refund = await adapter.refundPayment({ pspPaymentId: paymentId, amount: 400, idempotencyKey: freshKey() });
    fake.setRefundFields(refund.refundId, { amount: "400" });
    await expect(adapter.retrieveRefund(refund.refundId)).resolves.toMatchObject({ amount: 400 });
    const { refunds } = await adapter.listRefunds({ pspPaymentId: paymentId });
    expect(refunds).toMatchObject([{ refundId: refund.refundId, amount: 400 }]);
  });

  it("reads a subscription's amount and interval sent as digit strings", async () => {
    const { adapter, fake } = makePair();
    const subscription = fake.seedSubscription({ interval_unit: "monthly" });
    fake.setSubscriptionFields(subscription.id, { amount: "2500", interval: "3" });
    await expect(adapter.retrieveNativeSubscription({ subscriptionId: subscription.id })).resolves.toMatchObject({
      amount: 2500,
      interval: "month",
      intervalCount: 3,
    });
    const { subscriptions } = await adapter.listNativeSubscriptions();
    expect(subscriptions).toMatchObject([{ id: subscription.id, amount: 2500, intervalCount: 3 }]);
  });

  // JSON carries no NaN or Infinity; these are what a wire answer can hold.
  const malformed: unknown[] = ["10.00", 10.5, "-5", -5, "", " 5", "1e3", "0x10", true, {}, "9007199254740993"];

  it("fails a payment read closed on an amount that is not a whole number of minor units", async () => {
    const { adapter, fake } = makePair();
    const payment = fake.seedPayment();
    for (const field of ["amount", "amount_refunded"]) {
      for (const value of malformed) {
        fake.setPaymentFields(payment.id, { amount: 1000, amount_refunded: 0, [field]: value });
        await expect(adapter.retrievePayment(payment.id), `${field} ${JSON.stringify(value)}`).rejects.toMatchObject({
          code: "unknown",
          retryable: false,
          pspName: "gocardless",
          message: "GoCardless returned a payment whose amount is not a whole number of minor units.",
          raw: { id: payment.id },
        });
        await expect(adapter.listPayments()).rejects.toMatchObject({ code: "unknown", raw: { id: payment.id } });
      }
    }
  });

  it("fails billing request, refund and subscription reads closed the same way", async () => {
    const { adapter, fake } = makePair();
    const session = await adapter.createPaymentSession(sessionInput());
    const paymentId = await confirmedPayment(adapter, fake);
    const refund = await adapter.refundPayment({ pspPaymentId: paymentId, amount: 100, idempotencyKey: freshKey() });
    const subscription = fake.seedSubscription();
    for (const value of malformed) {
      const label = JSON.stringify(value);
      fake.setBillingRequestFields(session.pspSessionId, {
        payment_request: { amount: value, currency: "GBP", description: "Payment" },
      });
      await expect(adapter.retrievePayment(session.pspSessionId), label).rejects.toMatchObject({
        code: "unknown",
        message: "GoCardless returned a billing request whose amount is not a whole number of minor units.",
        raw: { id: session.pspSessionId },
      });
      fake.setRefundFields(refund.refundId, { amount: value });
      await expect(adapter.retrieveRefund(refund.refundId), label).rejects.toMatchObject({
        code: "unknown",
        message: "GoCardless returned a refund whose amount is not a whole number of minor units.",
        raw: { id: refund.refundId },
      });
      await expect(adapter.listRefunds({ pspPaymentId: paymentId }), label).rejects.toMatchObject({ code: "unknown" });
      fake.setSubscriptionFields(subscription.id, { amount: value });
      await expect(adapter.retrieveNativeSubscription({ subscriptionId: subscription.id }), label).rejects.toMatchObject({
        code: "unknown",
        message: "GoCardless returned a subscription whose amount is not a whole number of minor units.",
        raw: { id: subscription.id },
      });
      await expect(adapter.listNativeSubscriptions(), label).rejects.toMatchObject({ code: "unknown" });
    }
  });

  it("omits the cadence of a subscription whose interval does not read, never guessing one", async () => {
    const { adapter, fake } = makePair();
    const subscription = fake.seedSubscription({ interval_unit: "weekly" });
    for (const interval of [0, "0", "1.5", 1.5, "two", -1]) {
      fake.setSubscriptionFields(subscription.id, { interval });
      const record = await adapter.retrieveNativeSubscription({ subscriptionId: subscription.id });
      expect(record, JSON.stringify(interval)).toMatchObject({ amount: 2500 });
      expect(record.interval, JSON.stringify(interval)).toBeUndefined();
      expect(record.intervalCount, JSON.stringify(interval)).toBeUndefined();
    }
  });
});

describe("GoCardless fallback_enabled", () => {
  it("is sent only when fallbackEnabled is true", async () => {
    const cases: Array<[boolean | undefined, boolean]> = [
      [undefined, false],
      [false, false],
      [true, true],
    ];
    for (const [fallbackEnabled, sent] of cases) {
      const { adapter, fake } = makePair(fallbackEnabled === undefined ? {} : { fallbackEnabled });
      await adapter.createPaymentSession(sessionInput());
      const body = lastCreate(fake, "/billing_requests", "billing_requests");
      if (sent) expect(body["fallback_enabled"], String(fallbackEnabled)).toBe(true);
      else expect(body, String(fallbackEnabled)).not.toHaveProperty("fallback_enabled");
    }
  });
});

describe("GoCardless session amounts", () => {
  it("refuses a zero amount before any request, as core already refuses negative and fractional ones", async () => {
    const { adapter, fake } = makePair();
    await expect(adapter.createPaymentSession(sessionInput({ amount: 0 }))).rejects.toMatchObject({
      code: "invalid_request",
      retryable: false,
      message: "createPaymentSession requires a positive amount — this adapter does not support zero-amount payment method verification",
      raw: { amount: 0 },
    });
    for (const amount of [-1, 10.5]) {
      await expect(adapter.createPaymentSession(sessionInput({ amount })), String(amount)).rejects.toMatchObject({
        code: "invalid_request",
      });
    }
    expect(fake.requests).toHaveLength(0);
    await expect(adapter.createPaymentSession(sessionInput({ amount: 1 }))).resolves.toMatchObject({ amount: 1 });
  });
});

describe("GoCardless subscription intervals", () => {
  const cases: Array<["week" | "month" | "year", number]> = [
    ["week", 52],
    ["month", 12],
    ["year", 1],
  ];
  for (const [interval, max] of cases) {
    it(`sends intervalCount ${max} for "${interval}" and refuses ${max + 1}, which misses a year`, async () => {
      const { adapter, fake } = makePair();
      const input = (intervalCount: number) => ({
        savedPaymentMethodToken: fake.seedMandate().id,
        amount: 1000,
        currency: "GBP",
        interval,
        intervalCount,
        idempotencyKey: freshKey(),
      });
      await expect(adapter.createNativeSubscription(input(max + 1))).rejects.toMatchObject({
        code: "invalid_request",
        retryable: false,
        message: `GoCardless subscriptions must charge at least once a year, so intervalCount is at most ${max} for interval "${interval}"`,
        raw: { interval, intervalCount: max + 1 },
      });
      expect(fake.requests).toHaveLength(0);
      await expect(adapter.createNativeSubscription(input(max))).resolves.toMatchObject({
        interval,
        intervalCount: max,
      });
      expect(lastCreate(fake, "/subscriptions", "subscriptions")["interval"]).toBe(max);
    });
  }
});
