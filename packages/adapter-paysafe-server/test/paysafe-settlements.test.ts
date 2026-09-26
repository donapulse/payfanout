import { describe, expect, it } from "vitest";
import { getRefundState, isPayFanoutError, type PayFanoutError } from "@payfanout/core";
import { PaysafeServerAdapter, type PaysafeServerAdapterConfig } from "../src/index.js";
import { FakePaysafeApi, type RecordedRequest, type RequestMatcher } from "./fake-paysafe-api.js";

/**
 * How reads and refunds find a payment's settlements. Paysafe lists them by
 * merchantRefNum alone (GET /v1/settlements), over the last 30 days unless a
 * startDate says otherwise, so a full capture settles under a reference
 * derived from the payment and every lookup starts the day before it.
 */

const SETTLEMENTS = "/paymenthub/v1/settlements";
const SETTLE_PATH = /^\/paymenthub\/v1\/payments\/[^/]+\/settlements$/;
const SETTLE: RequestMatcher = { method: "POST", path: SETTLE_PATH };

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
    sessionSigningKey: "session-signing-key",
    webhookHmacKey: "webhook-hmac-key",
    fetch: fake.fetch,
    sleep: async () => undefined,
    ...config,
  });
  return { adapter, fake };
}

/** A card payment completed on the fake's current day, captured with its authorization or not. */
async function complete(
  adapter: PaysafeServerAdapter,
  captureMethod: "automatic" | "manual",
  amount = 2000,
  currency = "USD",
): Promise<string> {
  const session = await adapter.createPaymentSession({ amount, currency, captureMethod, idempotencyKey: "k-session" });
  const info = await adapter.completePayment({
    pspSessionId: session.pspSessionId,
    clientToken: `tok_${captureMethod}`,
    idempotencyKey: `k-${captureMethod}`,
  });
  return info.pspPaymentId;
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

function sent(fake: FakePaysafeApi, matcher: RequestMatcher): RecordedRequest[] {
  return fake.requests.filter(
    (r) => r.method === matcher.method && (typeof matcher.path === "string" ? r.path === matcher.path : matcher.path.test(r.path)),
  );
}

/** The settlement lookups the fake received, all or those under one reference, as their query parameters. */
function settlementLookups(fake: FakePaysafeApi, merchantRefNum?: string): URLSearchParams[] {
  return fake.requests
    .filter((r) => r.method === "GET" && r.path === SETTLEMENTS)
    .map((r) => new URLSearchParams(r.search))
    .filter((params) => merchantRefNum === undefined || params.get("merchantRefNum") === merchantRefNum);
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

/** Holds each call until `parties` have arrived, then lets them all through in arrival order. */
function rendezvous(parties: number): () => Promise<void> {
  let arrived = 0;
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return () => {
    arrived += 1;
    if (arrived >= parties) open();
    return opened;
  };
}

describe("Paysafe captures a refund can find", () => {
  it("refunds a payment captured in full, which settles under the payment's own reference", async () => {
    // A full capture: no amount (all that remains) or the authorized amount, in 2-, 0- and 3-decimal currencies.
    for (const [currency, authorized] of [["USD", 2000], ["JPY", 500], ["BHD", 1234]] as const) {
      for (const amount of [undefined, authorized]) {
        const label = `${currency} ${String(amount)}`;
        const { adapter, fake } = makePair();
        const id = await complete(adapter, "manual", authorized, currency);
        await adapter.capturePayment(id, amount, "k-capture");
        expect(sent(fake, SETTLE)[0]!.body, label).toEqual({
          merchantRefNum: `payfanout-capture-${id}`,
          dupCheck: true,
          amount: authorized,
        });
        const partial = await adapter.refundPayment({ pspPaymentId: id, amount: 100, idempotencyKey: "k-refund-1" });
        expect(partial, label).toMatchObject({ status: "succeeded", amount: 100 });
        const rest = await adapter.refundPayment({ pspPaymentId: id, idempotencyKey: "k-refund-2" });
        expect(rest, label).toMatchObject({ status: "succeeded", amount: authorized - 100 });
        expect(fake.uniqueRefundCreations, label).toBe(2);
      }
    }
  });

  it("reports a manually captured payment's capture time and refunds", async () => {
    const { adapter } = makePair();
    const id = await complete(adapter, "manual");
    const captured = await adapter.capturePayment(id, undefined, "k-capture");
    expect(captured).toMatchObject({
      status: "succeeded",
      amount: 2000,
      amountCaptured: 2000,
      amountCapturable: 0,
      amountRefunded: 0,
      capturedAt: "2026-07-04T10:05:00.000Z",
    });
    await adapter.refundPayment({ pspPaymentId: id, amount: 700, idempotencyKey: "k-refund" });
    const info = await adapter.retrievePayment(id);
    expect(info).toMatchObject({ amountCaptured: 2000, amountRefunded: 700, capturedAt: "2026-07-04T10:05:00.000Z" });
    expect(getRefundState(info)).toBe("partial");
  });

  it("keeps the caller's key on a partial capture, and says why refundPayment cannot reach its settlement", async () => {
    const { adapter, fake } = makePair();
    const id = await complete(adapter, "manual");
    const captured = await adapter.capturePayment(id, 700, "k-capture-part");
    expect(sent(fake, SETTLE)[0]!.body).toEqual({ merchantRefNum: "k-capture-part", dupCheck: true, amount: 700 });
    // availableToSettle witnesses the captured amount; no read finds the settlement itself.
    expect(captured).toMatchObject({ status: "succeeded", amount: 700, amountCaptured: 700, amountCapturable: 1300 });
    expect(captured.capturedAt).toBeUndefined();
    const err = await rejection(adapter.refundPayment({ pspPaymentId: id, idempotencyKey: "k-refund" }));
    expect(err).toMatchObject({ code: "invalid_request", retryable: false, raw: { id } });
    expect(err.message).toContain("or it was captured in part");
    expect(err.message).toContain(
      "A partial capture settles under the capture's idempotency key, which PayFanout cannot find from the payment: " +
        "refund that settlement in the Paysafe portal, where the key is its merchantRefNum",
    );
    expect(fake.uniqueRefundCreations).toBe(0);
  });

  it("counts earlier partial captures once the rest is captured, and refunds that rest", async () => {
    const { adapter, fake } = makePair();
    const id = await complete(adapter, "manual");
    await adapter.capturePayment(id, 700, "k-capture-part");
    const rest = await adapter.capturePayment(id, undefined, "k-capture-rest");
    expect(sent(fake, SETTLE)[1]!.body).toEqual({ merchantRefNum: `payfanout-capture-${id}`, dupCheck: true, amount: 1300 });
    expect(rest).toMatchObject({ status: "succeeded", amount: 2000, amountCaptured: 2000, amountCapturable: 0 });
    expect(rest.capturedAt).toBe("2026-07-04T10:05:00.000Z");
    // Only the rest's settlement can be found, so only it is refunded here.
    const refund = await adapter.refundPayment({ pspPaymentId: id, idempotencyKey: "k-refund" });
    expect(refund).toMatchObject({ status: "succeeded", amount: 1300 });
    const info = await adapter.retrievePayment(id);
    expect(info).toMatchObject({ amount: 2000, amountCaptured: 2000, amountRefunded: 1300 });
    expect(getRefundState(info)).toBe("partial");
    await expect(
      adapter.refundPayment({ pspPaymentId: id, amount: 100, idempotencyKey: "k-refund-more" }),
    ).rejects.toMatchObject({ code: "invalid_request", message: expect.stringMatching(/no refundable settlement/) });
  });

  it("refunds from settlements the payment carries, without a lookup", async () => {
    // If Paysafe lists a payment's settlements on it, as its schema allows, a partial capture is reachable too.
    const requests: string[] = [];
    const payment = {
      id: "pay_1",
      merchantRefNum: "k-manual",
      status: "COMPLETED",
      amount: 2000,
      availableToSettle: 1300,
      currencyCode: "USD",
      settleWithAuth: false,
      txnTime: "2026-07-04T10:00:00Z",
      settlements: [
        { id: "stl_part", merchantRefNum: "k-capture-part", status: "COMPLETED", amount: 700, availableToRefund: 700, txnTime: "2026-07-04T10:05:00Z" },
      ],
    };
    const { adapter } = makePair({
      fetch: async (input, init) => {
        const url = new URL(urlOf(input));
        requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
        const body =
          init?.method === "POST" ? { id: "ref_1", merchantRefNum: "k-refund", status: "COMPLETED", amount: 700 } : payment;
        return new Response(JSON.stringify(body), { status: 200 });
      },
    });
    expect(await adapter.retrievePayment("pay_1")).toMatchObject({
      amountCaptured: 700,
      capturedAt: "2026-07-04T10:05:00.000Z",
    });
    const refund = await adapter.refundPayment({ pspPaymentId: "pay_1", idempotencyKey: "k-refund" });
    expect(refund).toMatchObject({ refundId: "ref_1", status: "succeeded", amount: 700 });
    expect(requests).toEqual([
      "GET /paymenthub/v1/payments/pay_1",
      "GET /paymenthub/v1/payments/pay_1",
      "POST /paymenthub/v1/settlements/stl_part/refunds",
    ]);
  });

  it("gives a declined attempt none of the settlement its reused key's payment made", async () => {
    // A card completion keyed by order: the declined attempt and the payment that went through share the reference.
    const { adapter, fake } = makePair();
    for (const [clientToken, sessionKey] of [["tok_declined", "k-session-1"], ["tok_new", "k-session-2"]] as const) {
      const session = await adapter.createPaymentSession({ amount: 2000, currency: "USD", idempotencyKey: sessionKey });
      await adapter.completePayment({ pspSessionId: session.pspSessionId, clientToken, idempotencyKey: "order-1" }).catch(() => undefined);
    }
    const lookup = await fake.fetch("https://api.test.paysafe.com/paymenthub/v1/payments?merchantRefNum=order-1", {
      method: "GET",
      headers: { authorization: "Basic dGVzdA==" },
    });
    const filed = ((await lookup.json()) as { payments: Array<{ id: string; status: string }> }).payments;
    const declined = filed.find((p) => p.status === "FAILED")!;
    const paid = filed.find((p) => p.status === "COMPLETED")!;
    expect(await adapter.retrievePayment(declined.id)).toMatchObject({ status: "failed", amount: 2000, amountRefunded: 0 });
    const refused = await rejection(adapter.refundPayment({ pspPaymentId: declined.id, idempotencyKey: "k-refund-1" }));
    expect(refused).toMatchObject({ code: "invalid_request" });
    expect(fake.uniqueRefundCreations).toBe(0);
    expect(settlementLookups(fake, "order-1")).toHaveLength(0);
    // The payment that went through still finds and refunds its own settlement.
    const refund = await adapter.refundPayment({ pspPaymentId: paid.id, idempotencyKey: "k-refund-2" });
    expect(refund).toMatchObject({ status: "succeeded", amount: 2000 });
  });
});

describe("Paysafe full-capture replays", () => {
  it("answers a full capture retried after its lost answer could not be read back, settling once", async () => {
    for (const amount of [undefined, 2000]) {
      const label = String(amount);
      const { adapter, fake } = makePair();
      const id = await complete(adapter, "manual");
      const reference = `payfanout-capture-${id}`;
      fake.loseAnswer(SETTLE);
      // The three reads after the lost answer trail the write.
      fake.hideFromLookups("settlements", reference, 3);
      const err = await rejection(adapter.capturePayment(id, amount, "k-capture"));
      expect(err, label).toMatchObject({ code: "processing_error", retryable: false, outcomeUnknown: true });
      expect(err.message).toContain(`merchantRefNum "${reference}" went unanswered`);
      const retried = await adapter.capturePayment(id, amount, "k-capture");
      expect(retried, label).toMatchObject({ status: "succeeded", amountCaptured: 2000, amountCapturable: 0 });
      // With nothing left to settle the retry reads its settlement first; with an amount it is refused, then read back.
      expect(sent(fake, SETTLE), label).toHaveLength(amount === undefined ? 1 : 2);
      expect(fake.uniqueSettlementCreations, label).toBe(1);
    }
  });

  it("meets the first full capture's settlement under another key instead of refusing or settling again", async () => {
    for (const stateCheckFirst of [false, true]) {
      for (const [first, second] of [[undefined, undefined], [undefined, 2000], [2000, undefined], [2000, 2000]]) {
        const label = `stateCheckFirst ${stateCheckFirst}: ${String(first)} then ${String(second)}`;
        const { adapter, fake } = makePair();
        fake.stateCheckFirst = stateCheckFirst;
        const id = await complete(adapter, "manual");
        await adapter.capturePayment(id, first, "k-capture-1");
        const again = await adapter.capturePayment(id, second, "k-capture-2");
        expect(again, label).toMatchObject({ status: "succeeded", amountCaptured: 2000, amountCapturable: 0 });
        expect(fake.uniqueSettlementCreations, label).toBe(1);
        expect(await adapter.refundPayment({ pspPaymentId: id, idempotencyKey: "k-refund" }), label).toMatchObject({
          status: "succeeded",
          amount: 2000,
        });
      }
    }
  });

  it("settles once when two full captures are sent together, both answering with that settlement", async () => {
    for (const stateCheckFirst of [false, true]) {
      const fake = new FakePaysafeApi();
      fake.stateCheckFirst = stateCheckFirst;
      const together = rendezvous(2);
      const { adapter } = makePair({
        fetch: async (input, init) => {
          // Both have read the payment before either settles.
          if (init?.method === "POST" && SETTLE_PATH.test(new URL(urlOf(input)).pathname)) await together();
          return fake.fetch(input, init);
        },
      });
      const id = await complete(adapter, "manual");
      const [a, b] = await Promise.all([
        adapter.capturePayment(id, undefined, "k-capture-a"),
        adapter.capturePayment(id, 2000, "k-capture-b"),
      ]);
      for (const captured of [a, b]) {
        expect(captured, `stateCheckFirst ${stateCheckFirst}`).toMatchObject({ status: "succeeded", amountCaptured: 2000 });
      }
      expect(fake.uniqueSettlementCreations).toBe(1);
      expect(sent(fake, SETTLE)).toHaveLength(2);
    }
  });
});

describe("Paysafe settlement lookups", () => {
  it("finds and refunds a settlement older than Paysafe's default 30-day window", async () => {
    for (const captureMethod of ["automatic", "manual"] as const) {
      const { adapter, fake } = makePair();
      const id = await complete(adapter, captureMethod);
      if (captureMethod === "manual") await adapter.capturePayment(id, undefined, "k-capture");
      fake.passDays(45);
      const refund = await adapter.refundPayment({ pspPaymentId: id, amount: 500, idempotencyKey: "k-refund" });
      expect(refund, captureMethod).toMatchObject({ status: "succeeded", amount: 500 });
      const info = await adapter.retrievePayment(id);
      expect(info, captureMethod).toMatchObject({ amountCaptured: 2000, amountRefunded: 500 });
      expect(info.capturedAt, captureMethod).toBeDefined();
    }
  });

  it("starts every settlement read the day before the payment, and leaves the replay reads on the default window", async () => {
    const { adapter, fake } = makePair();
    const paid = await complete(adapter, "automatic");
    const authorized = await complete(adapter, "manual");
    // The capture's answer is lost, so it is read back under its key.
    fake.loseAnswer(SETTLE);
    await adapter.capturePayment(authorized, 700, "k-capture");
    const reads = {
      retrievePayment: () => adapter.retrievePayment(paid),
      refundPayment: () => adapter.refundPayment({ pspPaymentId: paid, amount: 100, idempotencyKey: "k-refund" }),
      cancelPayment: () => adapter.cancelPayment(authorized, "k-void"),
    };
    for (const [name, read] of Object.entries(reads)) {
      const before = fake.requests.length;
      await read();
      const lookups = fake.requests.slice(before).filter((r) => r.method === "GET" && r.path === SETTLEMENTS);
      expect(lookups.length, name).toBeGreaterThan(0);
      // Both payments were made on 2026-07-04, at 10:00 UTC.
      for (const lookup of lookups) expect(new URLSearchParams(lookup.search).get("startDate"), name).toBe("2026-07-03");
    }
    // That read-back looks for a write made moments before, over the default window.
    const readBack = settlementLookups(fake, "k-capture");
    expect(readBack).toHaveLength(1);
    expect(readBack[0]!.has("startDate")).toBe(false);
  });

  it("dates the lookup's start from the payment's txnTime, in UTC, whatever form Paysafe sends it in", async () => {
    const at = Date.parse("2026-07-04T10:00:00Z");
    const cases: Array<[unknown, string]> = [
      ["2026-07-04T10:00:00Z", "2026-07-03"],
      ["2026-07-04T00:00:00Z", "2026-07-03"],
      ["2026-07-04T23:59:59Z", "2026-07-03"],
      ["2026-07-05T01:00:00+02:00", "2026-07-03"],
      // The offset form of 25 of the spec's response examples.
      ["2026-07-04T10:00:00.000+0000", "2026-07-03"],
      ["2026-03-01T05:00:00Z", "2026-02-28"],
      ["2028-03-01T05:00:00Z", "2028-02-29"],
      [at, "2026-07-03"],
      [String(at), "2026-07-03"],
    ];
    for (const [txnTime, expected] of cases) {
      const starts: Array<string | null> = [];
      const { adapter } = makePair({
        fetch: async (input) => {
          const url = new URL(urlOf(input));
          if (url.pathname === SETTLEMENTS) {
            starts.push(url.searchParams.get("startDate"));
            return new Response(JSON.stringify({ settlements: [] }));
          }
          return new Response(
            JSON.stringify({ id: "pay_1", merchantRefNum: "k-pay", status: "COMPLETED", amount: 500, currencyCode: "USD", settleWithAuth: true, txnTime }),
          );
        },
      });
      await adapter.retrievePayment("pay_1");
      expect(starts, String(txnTime)).toEqual([expected, expected]);
    }
  });

  it("sends no start date for a payment whose txnTime is missing or unreadable, and still finds a recent settlement", async () => {
    // 1e10 falls below the epoch milliseconds the adapter reads; a year past four digits has no YYYY-MM-DD form.
    for (const txnTime of [undefined, "not-a-date", 1e10, "+010000-01-02T00:00:00Z"]) {
      const fake = new FakePaysafeApi();
      const { adapter } = makePair({
        fetch: async (input, init) => {
          const response = await fake.fetch(input, init);
          if ((init?.method ?? "GET") !== "GET" || !/^\/paymenthub\/v1\/payments\/[^/]+$/.test(new URL(urlOf(input)).pathname)) {
            return response;
          }
          const payment = (await response.json()) as Record<string, unknown>;
          return new Response(JSON.stringify({ ...payment, txnTime }), { status: response.status });
        },
      });
      const id = await complete(adapter, "automatic");
      const refund = await adapter.refundPayment({ pspPaymentId: id, amount: 500, idempotencyKey: "k-refund" });
      expect(refund, String(txnTime)).toMatchObject({ status: "succeeded", amount: 500 });
      const lookups = settlementLookups(fake);
      expect(lookups.length, String(txnTime)).toBeGreaterThan(0);
      for (const lookup of lookups) expect(lookup.has("startDate"), String(txnTime)).toBe(false);
    }
  });

  it("asks again without a start date when Paysafe refuses the range, and finds what its default window shows", async () => {
    const { adapter, fake } = makePair();
    // Paysafe documents no widest range; the double refuses one past 40 days as a field error (400/5068).
    fake.lookupRangeLimitDays = 40;
    const id = await complete(adapter, "manual");
    fake.passDays(20);
    await adapter.capturePayment(id, undefined, "k-capture");
    // 46 days since the day before the payment, 25 since the capture.
    fake.passDays(25);
    const refund = await adapter.refundPayment({ pspPaymentId: id, amount: 500, idempotencyKey: "k-refund" });
    expect(refund).toMatchObject({ status: "succeeded", amount: 500 });
    const lookups = settlementLookups(fake, `payfanout-capture-${id}`).slice(-2);
    expect(lookups.map((params) => params.get("startDate"))).toEqual(["2026-07-03", null]);
  });

  it("leaves a settlement the default window no longer shows out of reach when Paysafe refuses the range, as before", async () => {
    const { adapter, fake } = makePair();
    fake.lookupRangeLimitDays = 40;
    const id = await complete(adapter, "automatic");
    fake.passDays(45);
    const err = await rejection(adapter.refundPayment({ pspPaymentId: id, idempotencyKey: "k-refund" }));
    expect(err).toMatchObject({ code: "invalid_request", message: expect.stringMatching(/no refundable settlement/) });
    // Each reference is asked with the range, then without it.
    expect(settlementLookups(fake).map((params) => [params.get("merchantRefNum"), params.get("startDate")])).toEqual([
      ["k-automatic", "2026-07-03"],
      ["k-automatic", null],
      [`payfanout-capture-${id}`, "2026-07-03"],
      [`payfanout-capture-${id}`, null],
    ]);
    expect(fake.uniqueRefundCreations).toBe(0);
  });

  it("asks again without a start date when a ranged lookup fails for any reason but not-found", async () => {
    const { adapter, fake } = makePair();
    const id = await complete(adapter, "automatic");
    // Every attempt of the ranged lookup fails (1 + maxNetworkRetries); the one without a start date goes through.
    fake.refuse({ method: "GET", path: SETTLEMENTS }, 503, 3);
    const refund = await adapter.refundPayment({ pspPaymentId: id, amount: 500, idempotencyKey: "k-refund" });
    expect(refund).toMatchObject({ status: "succeeded", amount: 500 });
    expect(settlementLookups(fake).map((params) => params.get("startDate"))).toEqual([
      "2026-07-03",
      "2026-07-03",
      "2026-07-03",
      null,
    ]);
  });

  it("asks once more at most, and reads a reference whose lookups all fail as holding no settlement, as before", async () => {
    const { adapter, fake } = makePair();
    const id = await complete(adapter, "automatic");
    // Three attempts with the start date, then three without it, for each of the two references.
    fake.refuse({ method: "GET", path: SETTLEMENTS }, 503, 12);
    const err = await rejection(adapter.refundPayment({ pspPaymentId: id, idempotencyKey: "k-refund" }));
    expect(err).toMatchObject({ code: "invalid_request", message: expect.stringMatching(/no refundable settlement/) });
    const perReference = ["2026-07-03", "2026-07-03", "2026-07-03", null, null, null];
    expect(settlementLookups(fake).map((params) => [params.get("merchantRefNum"), params.get("startDate")])).toEqual([
      ...perReference.map((start) => ["k-automatic", start]),
      ...perReference.map((start) => [`payfanout-capture-${id}`, start]),
    ]);
    expect(fake.uniqueRefundCreations).toBe(0);
  });

  it("reads a not-found answer to a ranged lookup as no settlement under that reference, without asking again", async () => {
    const fake = new FakePaysafeApi();
    const lookups: Array<[string | null, string | null]> = [];
    const { adapter } = makePair({
      fetch: async (input, init) => {
        const url = new URL(urlOf(input));
        if (url.pathname !== SETTLEMENTS) return fake.fetch(input, init);
        lookups.push([url.searchParams.get("merchantRefNum"), url.searchParams.get("startDate")]);
        if (url.searchParams.get("merchantRefNum") !== "k-automatic") return fake.fetch(input, init);
        return new Response(JSON.stringify({ error: { code: "5269", message: "Entity not found" } }), { status: 404 });
      },
    });
    const id = await complete(adapter, "automatic");
    const err = await rejection(adapter.refundPayment({ pspPaymentId: id, idempotencyKey: "k-refund" }));
    expect(err.message).toMatch(/no refundable settlement/);
    expect(lookups).toEqual([
      ["k-automatic", "2026-07-03"],
      [`payfanout-capture-${id}`, "2026-07-03"],
    ]);
  });
});
