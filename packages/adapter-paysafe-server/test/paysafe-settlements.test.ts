import { describe, expect, it } from "vitest";
import { getRefundState, isPayFanoutError, type PayFanoutError, type PaymentInfo } from "@payfanout/core";
import { PaysafeServerAdapter, type PaysafeServerAdapterConfig } from "../src/index.js";
import { FakePaysafeApi, type RecordedFailure, type RecordedRequest, type RequestMatcher } from "./fake-paysafe-api.js";

/**
 * How reads and refunds find a payment's settlements. Paysafe lists them by
 * merchantRefNum alone (GET /v1/settlements), over the last 30 days unless a
 * startDate says otherwise, so a full capture settles under references
 * derived from the payment, and the lookups start the day before it.
 */

const SETTLEMENTS = "/paymenthub/v1/settlements";
const PAYMENT_PATH = /^\/paymenthub\/v1\/payments\/[^/]+$/;
const SETTLE_PATH = /^\/paymenthub\/v1\/payments\/[^/]+\/settlements$/;
const SETTLE: RequestMatcher = { method: "POST", path: SETTLE_PATH };
const VOID: RequestMatcher = { method: "POST", path: /^\/paymenthub\/v1\/payments\/[^/]+\/voidauths$/ };
const REFUND: RequestMatcher = { method: "POST", path: /^\/paymenthub\/v1\/settlements\/[^/]+\/refunds$/ };

/** Settlement failures from the spec's error tables: a gateway rejection (402) and an internal error (500). */
const GATEWAY_REJECTION: RecordedFailure = {
  status: 402,
  code: "3206",
  message: "The external processing gateway has rejected the transaction.",
};
const INTERNAL_ERROR: RecordedFailure = { status: 500, code: "1000", message: "An internal error occurred." };

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

/** A card payment completed on the fake's current day under `key`, captured with its authorization or not. */
async function complete(
  adapter: PaysafeServerAdapter,
  captureMethod: "automatic" | "manual",
  amount = 2000,
  currency = "USD",
  key = `k-${captureMethod}`,
): Promise<string> {
  const session = await adapter.createPaymentSession({ amount, currency, captureMethod, idempotencyKey: `${key}-session` });
  const info = await adapter.completePayment({
    pspSessionId: session.pspSessionId,
    clientToken: `tok_${key}`,
    idempotencyKey: key,
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
  return lookupsIn(fake.requests, merchantRefNum);
}

function lookupsIn(requests: RecordedRequest[], merchantRefNum?: string): URLSearchParams[] {
  return requests
    .filter((r) => r.method === "GET" && r.path === SETTLEMENTS)
    .map((r) => new URLSearchParams(r.search))
    .filter((params) => merchantRefNum === undefined || params.get("merchantRefNum") === merchantRefNum);
}

/** The references a payment's full captures settle under, in the order they are used. */
function fullCaptureRefs(id: string): string[] {
  return Array.from({ length: 10 }, (_, i) => (i === 0 ? `payfanout-capture-${id}` : `payfanout-capture-${id}-a${i + 1}`));
}

/** The settlement a capture's answer carries beside the payment. */
function captureSettlementOf(info: PaymentInfo): Record<string, unknown> {
  return (info.raw as { captureSettlement: Record<string, unknown> }).captureSettlement;
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

/** The fake's answers, every payment read still showing the whole authorization left: a read trailing the settlements. */
function trailingPaymentReads(fake: FakePaysafeApi): typeof fetch {
  return async (input, init) => {
    const response = await fake.fetch(input, init);
    if ((init?.method ?? "GET") !== "GET" || !PAYMENT_PATH.test(new URL(urlOf(input)).pathname)) return response;
    const payment = (await response.json()) as Record<string, unknown>;
    return new Response(JSON.stringify({ ...payment, availableToSettle: payment["amount"] }), { status: response.status });
  };
}

/** What a settlement write that cannot be read back ends with, and the retry advice it gives. */
function unreadable(merchantRefNum: string, advice: string): string {
  return (
    `Paysafe reports the settlement with merchantRefNum "${merchantRefNum}" as already processed, but it cannot be ` +
    `read back — ${advice}. Paysafe's lookup only reaches 30 days back, so an original older than that can never be ` +
    "read back: reconcile it in the Paysafe portal"
  );
}

function unanswered(merchantRefNum: string, advice: string): string {
  return (
    `An attempt of the settlement request with merchantRefNum "${merchantRefNum}" went unanswered and cannot be read ` +
    `back, so whether Paysafe processed it is unknown — ${advice}`
  );
}

const KEYED_RETRY = "retry later with the same idempotency key, never a new one";
const FULL_CAPTURE_RETRY = "retry the full capture later";

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

/**
 * A Paysafe stand-in serving one payment, and `settlements(merchantRefNum)`
 * to the settlement lookups; it records the references looked up.
 */
function oneParkedPayment(
  payment: Record<string, unknown>,
  settlements: (merchantRefNum: string) => Array<Record<string, unknown>> = () => [],
): { fetch: typeof fetch; lookedUp: string[]; posts: string[] } {
  const lookedUp: string[] = [];
  const posts: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(urlOf(input));
    if (init?.method === "POST") {
      posts.push(url.pathname);
      return new Response(JSON.stringify({ id: "ref_1", merchantRefNum: "k-refund", status: "COMPLETED", amount: 100 }));
    }
    if (url.pathname === SETTLEMENTS) {
      const merchantRefNum = url.searchParams.get("merchantRefNum")!;
      lookedUp.push(merchantRefNum);
      return new Response(JSON.stringify({ settlements: settlements(merchantRefNum) }));
    }
    if (url.pathname === "/paymenthub/v1/refunds") return new Response(JSON.stringify({ refunds: [] }));
    return new Response(JSON.stringify(payment));
  };
  return { fetch, lookedUp, posts };
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
    expect(err.message).toContain(`Payment ${id} has no refundable settlement: part of it is still only authorized`);
    expect(err.message).toContain("it was captured in part, or by an earlier release of this adapter");
    expect(err.message).toContain("Refund such a settlement in the Paysafe portal");
    expect(err.message).toContain("raw.captureSettlement");
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
    const err = await rejection(adapter.refundPayment({ pspPaymentId: id, amount: 100, idempotencyKey: "k-refund-more" }));
    expect(err).toMatchObject({ code: "invalid_request", retryable: false });
    expect(err.message).toContain("no refundable settlement: the settlement it has is not refundable yet");
    expect(err.message).toContain("it was captured in part");
    expect(err.message).not.toContain("only authorized");
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

  it("counts a full capture the payment carries only while its settlement moved money", async () => {
    const payment = { id: "pay_1", merchantRefNum: "k-manual", status: "COMPLETED", amount: 2000, currencyCode: "USD", settleWithAuth: false, txnTime: "2026-07-04T10:00:00Z" };
    const part = { id: "stl_part", merchantRefNum: "k-capture-part", status: "COMPLETED", amount: 700, availableToRefund: 700, txnTime: "2026-07-04T10:05:00Z" };
    const full = { id: "stl_full", merchantRefNum: "payfanout-capture-pay_1", amount: 1300, availableToRefund: 1300, txnTime: "2026-07-04T10:06:00Z" };
    const cases: Array<[string, Record<string, unknown>, Array<Record<string, unknown>>, Record<string, unknown>]> = [
      // A cancelled settlement returns its amount to the authorization, and leaves it to capture again.
      ["the full capture cancelled", { availableToSettle: 1300 }, [part, { ...full, status: "CANCELLED" }], { status: "succeeded", amount: 700, amountCaptured: 700, amountCapturable: 1300 }],
      ["only a cancelled full capture", { availableToSettle: 2000 }, [{ ...full, amount: 2000, status: "CANCELLED" }], { status: "requires_capture", amount: 2000, amountCaptured: 0, amountCapturable: 2000 }],
      // A read that trails the full capture still counts it, and the partial capture before it.
      ["the full capture pending", { availableToSettle: 1300 }, [part, { ...full, status: "PENDING" }], { status: "succeeded", amount: 2000, amountCaptured: 2000, amountCapturable: 0 }],
    ];
    for (const [label, fields, settlements, expected] of cases) {
      const stub = oneParkedPayment({ ...payment, ...fields, settlements });
      const { adapter } = makePair({ fetch: stub.fetch });
      expect(await adapter.retrievePayment("pay_1"), label).toMatchObject(expected);
      expect(stub.lookedUp, label).toEqual([]);
    }
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
    expect(refused).toMatchObject({ code: "invalid_request", retryable: false });
    expect(refused.message).toBe(`Payment ${declined.id} has no refundable settlement: it failed, so it settled nothing`);
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
      // The check before the write and the three reads after the lost answer all trail it.
      fake.hideFromLookups("settlements", reference, 4);
      const err = await rejection(adapter.capturePayment(id, amount, "k-capture"));
      expect(err, label).toMatchObject({ code: "processing_error", retryable: false, outcomeUnknown: true });
      expect(err.message).toContain(`merchantRefNum "${reference}" went unanswered`);
      const retried = await adapter.capturePayment(id, amount, "k-capture");
      expect(retried, label).toMatchObject({ status: "succeeded", amountCaptured: 2000, amountCapturable: 0 });
      // The retry finds the settlement before sending anything.
      expect(sent(fake, SETTLE), label).toHaveLength(1);
      expect(fake.uniqueSettlementCreations, label).toBe(1);
    }
  });

  it("answers a full capture retried while the lookup still trails its settled first attempt, instead of refusing it as nothing left", async () => {
    for (const amount of [undefined, 2000]) {
      const label = String(amount);
      const { adapter, fake } = makePair();
      const id = await complete(adapter, "manual");
      const reference = `payfanout-capture-${id}`;
      fake.loseAnswer(SETTLE);
      // The first attempt's check and three reads, and the retry's own walk, all trail the settlement.
      fake.hideFromLookups("settlements", reference, 5);
      const err = await rejection(adapter.capturePayment(id, amount, "k-capture"));
      expect(err, label).toMatchObject({ code: "processing_error", outcomeUnknown: true });
      // The payment read shows nothing left, so the retry reads the reference again before refusing.
      const retried = await adapter.capturePayment(id, amount, "k-capture");
      expect(retried, label).toMatchObject({ status: "succeeded", amountCaptured: 2000, amountCapturable: 0 });
      expect(captureSettlementOf(retried), label).toMatchObject({ merchantRefNum: reference, amount: 2000 });
      expect(sent(fake, SETTLE), label).toHaveLength(1);
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
        expect(sent(fake, SETTLE), label).toHaveLength(1);
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

  it("answers a capture of the authorized amount once the rest is captured with 'already captured in full', settling nothing", async () => {
    const { adapter, fake } = makePair();
    const id = await complete(adapter, "manual");
    await adapter.capturePayment(id, 700, "k-capture-part");
    await adapter.capturePayment(id, undefined, "k-capture-rest");
    const err = await rejection(adapter.capturePayment(id, 2000, "k-capture-all"));
    expect(err).toMatchObject({ code: "invalid_request", retryable: false, raw: { merchantRefNum: `payfanout-capture-${id}`, amount: 1300 } });
    expect(err.outcomeUnknown).toBeUndefined();
    expect(err.message).toBe(
      `Payment ${id} is already captured in full: its settlement under merchantRefNum "payfanout-capture-${id}" ` +
        "settled 1300, so a capture of 2000 has nothing left to settle",
    );
    expect(sent(fake, SETTLE)).toHaveLength(2);
    // Capturing everything again still answers with the payment.
    expect(await adapter.capturePayment(id, undefined, "k-capture-rest")).toMatchObject({ status: "succeeded", amountCaptured: 2000 });
    expect(sent(fake, SETTLE)).toHaveLength(2);
  });

  it("refuses a capture of the authorized amount that partial captures leave short, before sending it", async () => {
    for (const [parts, left] of [[[700], 1300], [[700, 1300], 0]] as const) {
      const label = `after ${parts.join(" and ")}`;
      const { adapter, fake } = makePair();
      // Were it sent, Paysafe would refuse it on state (3204, 3203), and under this reading hold its reference.
      fake.stateRefusalHoldsReference = true;
      const id = await complete(adapter, "manual");
      for (const [i, part] of parts.entries()) await adapter.capturePayment(id, part, `k-capture-part-${i}`);
      const before = sent(fake, SETTLE).length;
      const err = await rejection(adapter.capturePayment(id, 2000, "k-capture-all"));
      expect(err, label).toMatchObject({ code: "invalid_request", retryable: false, raw: { id, availableToSettle: left } });
      expect(err.outcomeUnknown, label).toBeUndefined();
      expect(err.message, label).toBe(
        left === 0
          ? `Payment ${id} has nothing left to capture: Paysafe shows none of its authorization left to settle, and no full capture of it. ` +
              "A full capture made moments ago may not show in Paysafe's lookup yet, so check retrievePayment before reading the payment as not captured"
          : `Payment ${id} has only 1300 of its authorization left to settle, not the 2000 this capture asks for: capture the rest with no amount`,
      );
      expect(sent(fake, SETTLE), label).toHaveLength(before);
      if (left > 0) {
        // Nothing went out under the payment's first reference, so the rest settles there.
        const rest = await adapter.capturePayment(id, undefined, "k-capture-rest");
        expect(captureSettlementOf(rest), label).toMatchObject({ merchantRefNum: `payfanout-capture-${id}`, amount: 1300 });
        expect(rest, label).toMatchObject({ status: "succeeded", amountCaptured: 2000, amountCapturable: 0 });
      }
    }
  });

  it("answers 'already captured in full' when the authorized amount, read before a partial capture showed, meets the rest sent together with it", async () => {
    for (const stateCheckFirst of [false, true]) {
      const fake = new FakePaysafeApi();
      fake.stateCheckFirst = stateCheckFirst;
      // Open until the calls to hold together are sent.
      let together = async (): Promise<void> => undefined;
      const held =
        (base: typeof fetch): typeof fetch =>
        async (input, init) => {
          if (init?.method === "POST" && SETTLE_PATH.test(new URL(urlOf(input)).pathname)) await together();
          return base(input, init);
        };
      const { adapter } = makePair({ fetch: held(fake.fetch) });
      // Its payment reads trail the partial capture, so its capture of the authorized amount is sent.
      const { adapter: trailing } = makePair({ fetch: held(trailingPaymentReads(fake)) });
      const id = await complete(adapter, "manual");
      await adapter.capturePayment(id, 700, "k-capture-part");
      together = rendezvous(2);
      const [rest, all] = await Promise.allSettled([
        adapter.capturePayment(id, undefined, "k-capture-rest"),
        trailing.capturePayment(id, 2000, "k-capture-all"),
      ]);
      const label = `stateCheckFirst ${stateCheckFirst}`;
      expect(rest, label).toMatchObject({ status: "fulfilled", value: { status: "succeeded", amountCaptured: 2000 } });
      expect(all, label).toMatchObject({ status: "rejected", reason: { code: "invalid_request", retryable: false } });
      const reason = (all as PromiseRejectedResult).reason as PayFanoutError;
      expect(reason.outcomeUnknown, label).toBeUndefined();
      expect(reason.message, label).toContain("is already captured in full");
      expect(fake.uniqueSettlementCreations, label).toBe(2);
    }
  });

  it("refuses to capture everything when nothing is left and no full capture shows, sending no settlement", async () => {
    const { adapter, fake } = makePair();
    const id = await complete(adapter, "manual");
    await adapter.capturePayment(id, 700, "k-capture-part");
    await adapter.cancelPayment(id, "k-void");
    const err = await rejection(adapter.capturePayment(id, undefined, "k-capture-rest"));
    expect(err).toMatchObject({ code: "invalid_request", retryable: false, raw: { id } });
    expect(err.outcomeUnknown).toBeUndefined();
    expect(err.message).toContain(`Payment ${id} has nothing left to capture`);
    expect(sent(fake, SETTLE)).toHaveLength(1);
  });

  it("tells the host to retry a full capture later, and a partial capture to keep its key, when the answer cannot be read back", async () => {
    for (const amount of [undefined, 2000, 700]) {
      for (const ending of ["unanswered", "duplicate"] as const) {
        const label = `${String(amount)} ${ending}`;
        const { adapter, fake } = makePair();
        const id = await complete(adapter, "manual");
        const reference = amount === 700 ? "k-capture" : `payfanout-capture-${id}`;
        if (ending === "unanswered") fake.loseAnswer(SETTLE);
        else fake.rejectAs(SETTLE, "3044");
        fake.hideFromLookups("settlements", reference);
        const err = await rejection(adapter.capturePayment(id, amount, "k-capture"));
        expect(err, label).toMatchObject({ code: "processing_error", retryable: false, outcomeUnknown: true });
        // A full capture's reference comes from the payment, so its key plays no part in the retry.
        const advice = amount === 700 ? KEYED_RETRY : FULL_CAPTURE_RETRY;
        expect(err.message, label).toBe(ending === "unanswered" ? unanswered(reference, advice) : unreadable(reference, advice));
      }
    }
  });

  it("does not move on to the next reference when the one a refused settlement may hold turns the rest away", async () => {
    // The undocumented reading where a settlement refused on state still holds its reference under dupCheck.
    const fake = new FakePaysafeApi();
    fake.stateRefusalHoldsReference = true;
    const { adapter } = makePair({ fetch: fake.fetch });
    const { adapter: trailing } = makePair({ fetch: trailingPaymentReads(fake) });
    const id = await complete(adapter, "manual");
    const [first] = fullCaptureRefs(id);
    await adapter.capturePayment(id, 700, "k-capture-part");
    // The rest, computed from a read that does not show the partial capture yet: Paysafe refuses it (3204).
    const refused = await rejection(trailing.capturePayment(id, undefined, "k-capture-rest"));
    expect(refused).toMatchObject({ code: "invalid_request", retryable: false, raw: { error: { code: "3204" } } });
    // The reference still looks free, and the right amount under it is refused as a duplicate with nothing to read back.
    const err = await rejection(adapter.capturePayment(id, undefined, "k-capture-rest"));
    expect(err).toMatchObject({ code: "processing_error", retryable: false, outcomeUnknown: true });
    expect(err.message).toBe(unreadable(first!, FULL_CAPTURE_RETRY));
    // The lookup may only trail a settlement there, so nothing is sent under the next reference.
    expect(sent(fake, SETTLE).map((r) => r.body?.["merchantRefNum"])).toEqual(["k-capture-part", first, first]);
    expect(fake.uniqueSettlementCreations).toBe(1);
  });
});

describe("Paysafe full captures after one that moved no money", () => {
  it("settles a full capture retried after a recorded failure under the next reference, whatever the key", async () => {
    const expected = { "3206": "card_declined", "1000": "processing_error" } as const;
    for (const failure of [GATEWAY_REJECTION, INTERNAL_ERROR]) {
      for (const retryKey of ["k-capture", "k-capture-2"]) {
        for (const amount of [undefined, 2000]) {
          const label = `${failure.code} ${retryKey} ${String(amount)}`;
          const { adapter, fake } = makePair();
          const id = await complete(adapter, "manual");
          fake.recordFailure(SETTLE, failure);
          const err = await rejection(adapter.capturePayment(id, amount, "k-capture"));
          expect(err, label).toMatchObject({ code: expected[failure.code as "3206" | "1000"], retryable: false });
          // The failed record still stands in dupCheck's 90 days.
          fake.passDays(30);
          const captured = await adapter.capturePayment(id, amount, retryKey);
          expect(captured, label).toMatchObject({ status: "succeeded", amountCaptured: 2000, amountCapturable: 0 });
          const [first, second] = fullCaptureRefs(id);
          expect(sent(fake, SETTLE).map((r) => r.body), label).toEqual([
            { merchantRefNum: first, dupCheck: true, amount: 2000 },
            { merchantRefNum: second, dupCheck: true, amount: 2000 },
          ]);
          expect(fake.uniqueSettlementCreations, label).toBe(1);
        }
      }
    }
  });

  it("captures again under the next reference once the full capture's settlement is cancelled while pending", async () => {
    for (const retryKey of ["k-capture", "k-capture-2"]) {
      const { adapter, fake } = makePair();
      const id = await complete(adapter, "manual");
      const first = await adapter.capturePayment(id, undefined, "k-capture");
      fake.cancelSettlement(captureSettlementOf(first)["id"] as string);
      expect(await adapter.retrievePayment(id), retryKey).toMatchObject({
        status: "requires_capture",
        amountCaptured: 0,
        amountCapturable: 2000,
      });
      const again = await adapter.capturePayment(id, undefined, retryKey);
      expect(again, retryKey).toMatchObject({ status: "succeeded", amountCaptured: 2000, amountCapturable: 0 });
      expect(sent(fake, SETTLE).map((r) => r.body?.["merchantRefNum"]), retryKey).toEqual(fullCaptureRefs(id).slice(0, 2));
      const refund = await adapter.refundPayment({ pspPaymentId: id, idempotencyKey: "k-refund" });
      expect(refund, retryKey).toMatchObject({ status: "succeeded", amount: 2000 });
    }
  });

  it("settles once when two full captures are retried together after a failure", async () => {
    for (const stateCheckFirst of [false, true]) {
      const fake = new FakePaysafeApi();
      fake.stateCheckFirst = stateCheckFirst;
      // Open until the calls to hold together are sent.
      let together = async (): Promise<void> => undefined;
      const { adapter } = makePair({
        fetch: async (input, init) => {
          if (init?.method === "POST" && SETTLE_PATH.test(new URL(urlOf(input)).pathname)) await together();
          return fake.fetch(input, init);
        },
      });
      const id = await complete(adapter, "manual");
      fake.recordFailure(SETTLE, GATEWAY_REJECTION);
      await rejection(adapter.capturePayment(id, undefined, "k-capture"));
      together = rendezvous(2);
      const answers = await Promise.all([
        adapter.capturePayment(id, undefined, "k-capture"),
        adapter.capturePayment(id, 2000, "k-capture-2"),
      ]);
      const label = `stateCheckFirst ${stateCheckFirst}`;
      for (const captured of answers) expect(captured, label).toMatchObject({ status: "succeeded", amountCaptured: 2000 });
      expect(fake.uniqueSettlementCreations, label).toBe(1);
      const [first, second] = fullCaptureRefs(id);
      expect(sent(fake, SETTLE).map((r) => r.body?.["merchantRefNum"]), label).toEqual([first, second, second]);
    }
  });

  it("reads back a lost answer on the next reference, and ends as retry-later under it when it cannot", async () => {
    for (const readable of [true, false]) {
      const { adapter, fake } = makePair();
      const id = await complete(adapter, "manual");
      const second = fullCaptureRefs(id)[1]!;
      fake.recordFailure(SETTLE, GATEWAY_REJECTION);
      await rejection(adapter.capturePayment(id, undefined, "k-capture"));
      fake.loseAnswer(SETTLE);
      if (!readable) fake.hideFromLookups("settlements", second);
      const outcome = adapter.capturePayment(id, undefined, "k-capture");
      if (readable) {
        await expect(outcome).resolves.toMatchObject({ status: "succeeded", amountCaptured: 2000 });
      } else {
        const err = await rejection(outcome);
        expect(err).toMatchObject({ code: "processing_error", retryable: false, outcomeUnknown: true });
        expect(err.message).toContain(`merchantRefNum "${second}" went unanswered`);
      }
      expect(sent(fake, SETTLE).map((r) => r.body?.["merchantRefNum"]), String(readable)).toEqual(fullCaptureRefs(id).slice(0, 2));
      expect(fake.uniqueSettlementCreations, String(readable)).toBe(1);
    }
  });

  it("refuses a full capture once every reference is spent, naming them, and sends nothing more", async () => {
    const { adapter, fake } = makePair();
    const id = await complete(adapter, "manual");
    const refs = fullCaptureRefs(id);
    for (const attempt of refs.keys()) {
      fake.recordFailure(SETTLE, GATEWAY_REJECTION);
      await expect(adapter.capturePayment(id, undefined, `k-capture-${attempt}`)).rejects.toMatchObject({ code: "card_declined" });
    }
    expect(sent(fake, SETTLE).map((r) => r.body?.["merchantRefNum"])).toEqual(refs);
    const err = await rejection(adapter.capturePayment(id, 2000, "k-capture-again"));
    expect(err).toMatchObject({ code: "invalid_request", retryable: false, raw: { merchantRefNums: refs } });
    expect(err.outcomeUnknown).toBeUndefined();
    expect(err.message).toContain(`every reference its full captures settle under moved no money: ${refs.join(", ")}`);
    expect(err.message).toContain("capture it in the Paysafe portal");
    expect(sent(fake, SETTLE)).toHaveLength(10);
    // Reads walk the same references and find nothing captured.
    expect(await adapter.retrievePayment(id)).toMatchObject({ status: "requires_capture", amountCaptured: 0, amountCapturable: 2000 });
  });

  it("reads and refunds a full capture filed under the next reference", async () => {
    const { adapter, fake } = makePair();
    const id = await complete(adapter, "manual");
    fake.recordFailure(SETTLE, INTERNAL_ERROR);
    await rejection(adapter.capturePayment(id, undefined, "k-capture"));
    const captured = await adapter.capturePayment(id, undefined, "k-capture");
    const settlement = captureSettlementOf(captured);
    expect(settlement).toMatchObject({ merchantRefNum: fullCaptureRefs(id)[1], amount: 2000 });
    expect(await adapter.retrievePayment(id)).toMatchObject({
      status: "succeeded",
      amountCaptured: 2000,
      amountCapturable: 0,
      capturedAt: "2026-07-04T10:05:00.000Z",
    });
    const refund = await adapter.refundPayment({ pspPaymentId: id, amount: 500, idempotencyKey: "k-refund" });
    expect(refund).toMatchObject({ status: "succeeded", amount: 500 });
    expect(sent(fake, REFUND).map((r) => r.path)).toEqual([`/paymenthub/v1/settlements/${String(settlement["id"])}/refunds`]);
    expect(await adapter.retrievePayment(id)).toMatchObject({ amountRefunded: 500 });
  });

  it("counts partial captures before a rest captured under the next reference", async () => {
    const { adapter, fake } = makePair();
    const id = await complete(adapter, "manual");
    await adapter.capturePayment(id, 700, "k-capture-part");
    fake.recordFailure(SETTLE, GATEWAY_REJECTION);
    await rejection(adapter.capturePayment(id, undefined, "k-capture-rest"));
    const rest = await adapter.capturePayment(id, undefined, "k-capture-rest");
    expect(captureSettlementOf(rest)).toMatchObject({ merchantRefNum: fullCaptureRefs(id)[1], amount: 1300 });
    const expected = { status: "succeeded", amount: 2000, amountCaptured: 2000, amountCapturable: 0 };
    expect(rest).toMatchObject(expected);
    expect(await adapter.retrievePayment(id)).toMatchObject(expected);
    const err = await rejection(adapter.refundPayment({ pspPaymentId: id, amount: 1500, idempotencyKey: "k-refund" }));
    expect(err).toMatchObject({ code: "invalid_request", raw: { error: { code: "3402" } } });
  });
});

describe("Paysafe capture answers", () => {
  it("carries the settlement a capture made or met on raw.captureSettlement, the payment's fields left as a read shows them", async () => {
    const { adapter, fake } = makePair();
    const id = await complete(adapter, "manual");
    const part = await adapter.capturePayment(id, 700, "k-capture-part");
    const raw = part.raw as Record<string, unknown>;
    expect(raw).toMatchObject({ id, merchantRefNum: "k-manual", amount: 2000, availableToSettle: 1300, settlements: [] });
    expect(raw["captureSettlement"]).toMatchObject({ merchantRefNum: "k-capture-part", amount: 700, status: "PENDING" });
    const read = await adapter.retrievePayment(id);
    expect(read.raw).not.toHaveProperty("captureSettlement");
    expect({ ...raw, captureSettlement: undefined }).toEqual({ ...(read.raw as Record<string, unknown>), captureSettlement: undefined });
    // A replay carries the settlement it read back.
    const replay = await adapter.capturePayment(id, 700, "k-capture-part");
    expect(captureSettlementOf(replay)["id"]).toBe((raw["captureSettlement"] as { id: string }).id);
    const rest = await adapter.capturePayment(id, undefined, "k-capture-rest");
    expect(captureSettlementOf(rest)).toMatchObject({ merchantRefNum: `payfanout-capture-${id}`, amount: 1300 });
    const again = await adapter.capturePayment(id, undefined, "k-capture-again");
    expect(captureSettlementOf(again)["id"]).toBe(captureSettlementOf(rest)["id"]);
    expect(fake.uniqueSettlementCreations).toBe(2);
  });

  it("answers a partial capture without a settlement lookup, so an outage after it settles cannot fail it", async () => {
    const fake = new FakePaysafeApi();
    let down = false;
    const { adapter } = makePair({
      fetch: async (input, init) => {
        const url = new URL(urlOf(input));
        if (down && url.pathname === SETTLEMENTS) {
          return new Response(JSON.stringify({ error: { code: "1000", message: "An internal error occurred." } }), { status: 503 });
        }
        const response = await fake.fetch(input, init);
        // The settlement lookups go down once the capture has settled.
        if (init?.method === "POST" && SETTLE_PATH.test(url.pathname)) down = true;
        return response;
      },
    });
    const id = await complete(adapter, "manual");
    const captured = await adapter.capturePayment(id, 700, "k-capture-part");
    expect(captured).toMatchObject({ status: "succeeded", amount: 700, amountCaptured: 700, amountCapturable: 1300 });
    expect(captureSettlementOf(captured)).toMatchObject({ merchantRefNum: "k-capture-part", amount: 700, status: "PENDING" });
    expect(fake.uniqueSettlementCreations).toBe(1);
    // The outage is real: a read after it fails, retryable.
    await expect(adapter.retrievePayment(id)).rejects.toMatchObject({ code: "psp_unavailable", retryable: true });
  });

  it("reports on a partial capture's answer what a read reports afterwards", async () => {
    const sameAsRead = async (adapter: PaysafeServerAdapter, id: string, amount: number, key: string): Promise<PaymentInfo> => {
      const answer = await adapter.capturePayment(id, amount, key);
      const { raw, ...captured } = answer;
      const { raw: readRaw, ...read } = await adapter.retrievePayment(id);
      expect(captured, key).toEqual(read);
      expect({ ...(raw as Record<string, unknown>), captureSettlement: undefined }, key).toEqual({ ...(readRaw as Record<string, unknown>), captureSettlement: undefined });
      return answer;
    };
    const { adapter } = makePair();
    const id = await complete(adapter, "manual");
    await sameAsRead(adapter, id, 700, "k-capture-1");
    expect(await sameAsRead(adapter, id, 500, "k-capture-2")).toMatchObject({ amount: 1200, amountCaptured: 1200, amountCapturable: 800 });
    // A payment read that lists its settlements reports them, on the answer as on a read.
    const payment = { id: "pay_1", merchantRefNum: "k-pay", status: "COMPLETED", amount: 2000, availableToSettle: 2000, currencyCode: "USD", settleWithAuth: false, txnTime: "2026-07-04T10:00:00Z" };
    const settled = { id: "stl_1", merchantRefNum: "k-capture-part", status: "PENDING", amount: 700, availableToRefund: 700, txnTime: "2026-07-04T10:05:00Z" };
    let captured = false;
    const listing = makePair({
      fetch: async (input, init) => {
        if (init?.method === "POST") {
          captured = true;
          return new Response(JSON.stringify(settled));
        }
        if (new URL(urlOf(input)).pathname === SETTLEMENTS) return new Response(JSON.stringify({ settlements: [] }));
        return new Response(JSON.stringify(captured ? { ...payment, availableToSettle: 1300, settlements: [settled] } : payment));
      },
    });
    expect(await sameAsRead(listing.adapter, "pay_1", 700, "k-capture-part")).toMatchObject({
      amountCaptured: 700,
      amountCapturable: 1300,
      capturedAt: "2026-07-04T10:05:00.000Z",
    });
  });

  it("refuses a partial capture under a key the adapter reserves for full captures, before any settlement request", async () => {
    const { adapter, fake } = makePair();
    const id = await complete(adapter, "manual");
    for (const key of [`payfanout-capture-${id}`, `payfanout-capture-${id}-a2`, "payfanout-capture-pay_other"]) {
      const before = fake.requests.length;
      const err = await rejection(adapter.capturePayment(id, 700, key));
      expect(err, key).toMatchObject({ code: "invalid_request", retryable: false, raw: { idempotencyKey: key } });
      expect(err.message, key).toContain(`idempotencyKey "${key}" starts with "payfanout-capture-"`);
      // Only the payment read, which tells a partial capture from a full one.
      expect(fake.requests.slice(before).map((r) => `${r.method} ${r.path}`), key).toEqual([`GET /paymenthub/v1/payments/${id}`]);
    }
    // A full capture sends no key, so any key does.
    expect(await adapter.capturePayment(id, 2000, `payfanout-capture-${id}`)).toMatchObject({ status: "succeeded" });
    expect(sent(fake, SETTLE).map((r) => r.body?.["merchantRefNum"])).toEqual([`payfanout-capture-${id}`]);
  });

  it("answers a full capture from the settlements the payment carries, when its read lists them", async () => {
    const payment = { id: "pay_1", merchantRefNum: "k-pay", status: "COMPLETED", amount: 1000, availableToSettle: 1000, currencyCode: "USD", settleWithAuth: false, txnTime: "2026-07-04T10:00:00Z" };
    const settled = { id: "stl_1", merchantRefNum: "payfanout-capture-pay_1", status: "PENDING", amount: 1000, availableToRefund: 1000, txnTime: "2026-07-04T10:05:00Z" };
    let captured = false;
    const { adapter } = makePair({
      fetch: async (input, init) => {
        const url = new URL(urlOf(input));
        if (init?.method === "POST") {
          captured = true;
          return new Response(JSON.stringify(settled));
        }
        if (url.pathname === SETTLEMENTS) return new Response(JSON.stringify({ settlements: [] }));
        const read = captured ? { ...payment, availableToSettle: 0, settlements: [{ ...settled, status: "COMPLETED" }] } : payment;
        return new Response(JSON.stringify(read));
      },
    });
    const info = await adapter.capturePayment("pay_1", undefined, "k-capture");
    expect(info).toMatchObject({ status: "succeeded", amountCaptured: 1000, amountCapturable: 0, capturedAt: "2026-07-04T10:05:00.000Z" });
    expect(info.raw).toMatchObject({ settlements: [{ id: "stl_1", status: "COMPLETED" }], captureSettlement: { id: "stl_1", status: "PENDING" } });
  });

  it("reports a full capture whose payment read still shows the authorization untouched", async () => {
    // The payment read can trail the settlement it has just taken: availableToSettle not reduced yet.
    const fake = new FakePaysafeApi();
    let trailing = false;
    const { adapter } = makePair({
      fetch: async (input, init) => {
        const response = await fake.fetch(input, init);
        if (!trailing || (init?.method ?? "GET") !== "GET" || !PAYMENT_PATH.test(new URL(urlOf(input)).pathname)) {
          return response;
        }
        const payment = (await response.json()) as Record<string, unknown>;
        return new Response(JSON.stringify({ ...payment, availableToSettle: payment["amount"] }), { status: response.status });
      },
    });
    const id = await complete(adapter, "manual");
    trailing = true;
    const expected = { status: "succeeded", amount: 2000, amountCaptured: 2000, amountCapturable: 0, capturedAt: "2026-07-04T10:05:00.000Z" };
    expect(await adapter.capturePayment(id, undefined, "k-capture")).toMatchObject(expected);
    expect(await adapter.retrievePayment(id)).toMatchObject(expected);
    expect(await adapter.capturePayment(id, 2000, "k-capture-again")).toMatchObject(expected);
    expect(fake.uniqueSettlementCreations).toBe(1);
  });
});

describe("Paysafe settlements under a completion key two payments share", () => {
  /**
   * Two completions under one key, the second sent before the first shows in
   * the lookup: the concurrency gap "Paysafe replay safety (2026-09-24)" leaves open.
   */
  async function twoPaymentsUnderOneKey(): Promise<{
    adapter: PaysafeServerAdapter;
    fake: FakePaysafeApi;
    authorized: string;
    paid: string;
  }> {
    const { adapter, fake } = makePair();
    const manual = await adapter.createPaymentSession({ amount: 2000, currency: "USD", captureMethod: "manual", idempotencyKey: "s-1" });
    const automatic = await adapter.createPaymentSession({ amount: 2000, currency: "USD", idempotencyKey: "s-2" });
    const first = await adapter.completePayment({ pspSessionId: manual.pspSessionId, clientToken: "tok_a", idempotencyKey: "order-1" });
    fake.hideFromLookups("payments", "order-1", 1);
    const second = await adapter.completePayment({ pspSessionId: automatic.pspSessionId, clientToken: "tok_b", idempotencyKey: "order-1" });
    expect(second.pspPaymentId).not.toBe(first.pspPaymentId);
    return { adapter, fake, authorized: first.pspPaymentId, paid: second.pspPaymentId };
  }

  it("never looks a manually captured payment's settlements up under its completion key", async () => {
    const { adapter, fake, authorized } = await twoPaymentsUnderOneKey();
    const before = fake.requests.length;
    expect(await adapter.retrievePayment(authorized)).toMatchObject({
      status: "requires_capture",
      amount: 2000,
      amountCaptured: 0,
      amountRefunded: 0,
    });
    const refused = await rejection(adapter.refundPayment({ pspPaymentId: authorized, idempotencyKey: "k-refund" }));
    expect(refused.message).toBe(`Payment ${authorized} has no refundable settlement: it is only authorized (cancel it instead)`);
    expect(fake.uniqueRefundCreations).toBe(0);
    expect(lookupsIn(fake.requests.slice(before)).map((params) => params.get("merchantRefNum"))).toEqual([
      `payfanout-capture-${authorized}`,
      `payfanout-capture-${authorized}`,
    ]);
  });

  it("looks an automatically captured payment's settlements up under its completion key alone", async () => {
    const { adapter, fake, paid } = await twoPaymentsUnderOneKey();
    const before = fake.requests.length;
    expect(await adapter.retrievePayment(paid)).toMatchObject({ status: "succeeded", amountCaptured: 2000 });
    expect(await adapter.refundPayment({ pspPaymentId: paid, amount: 500, idempotencyKey: "k-refund" })).toMatchObject({
      status: "succeeded",
      amount: 500,
    });
    expect(lookupsIn(fake.requests.slice(before)).map((params) => params.get("merchantRefNum"))).toEqual(["order-1", "order-1"]);
  });

  it("looks a payment that states no settleWithAuth up under its key first, then its own references", async () => {
    const payment = { id: "pay_1", merchantRefNum: "k-pay", status: "COMPLETED", amount: 1000, currencyCode: "USD", txnTime: "2026-07-04T10:00:00Z" };
    const live = (merchantRefNum: string): Record<string, unknown> => ({
      id: `stl_${merchantRefNum}`,
      merchantRefNum,
      status: "COMPLETED",
      amount: 1000,
      availableToRefund: 1000,
    });
    const cases: Array<[string, (merchantRefNum: string) => Array<Record<string, unknown>>, string[], string | undefined]> = [
      ["a settlement under its key", (ref) => (ref === "k-pay" ? [live(ref)] : []), ["k-pay"], "stl_k-pay"],
      ["none under its key", (ref) => (ref === "payfanout-capture-pay_1" ? [live(ref)] : []), ["k-pay", "payfanout-capture-pay_1"], "stl_payfanout-capture-pay_1"],
      [
        "only a cancelled one under its key",
        (ref) => (ref === "k-pay" ? [{ ...live(ref), status: "CANCELLED" }] : [live(ref)]),
        ["k-pay", "payfanout-capture-pay_1"],
        "stl_payfanout-capture-pay_1",
      ],
      ["nothing anywhere", () => [], ["k-pay", "payfanout-capture-pay_1"], undefined],
    ];
    for (const [label, settlements, lookedUp, refundedFrom] of cases) {
      const stub = oneParkedPayment(payment, settlements);
      const { adapter } = makePair({ fetch: stub.fetch });
      const outcome = adapter.refundPayment({ pspPaymentId: "pay_1", amount: 100, idempotencyKey: "k-refund" });
      if (refundedFrom === undefined) await expect(outcome, label).rejects.toMatchObject({ code: "invalid_request" });
      else await expect(outcome, label).resolves.toMatchObject({ status: "succeeded" });
      expect(stub.lookedUp, label).toEqual(lookedUp);
      expect(stub.posts, label).toEqual(refundedFrom === undefined ? [] : [`/paymenthub/v1/settlements/${refundedFrom}/refunds`]);
    }
    // With nothing under its own references either, what its key holds is what it reports.
    const cancelledOnly = oneParkedPayment(payment, (ref) => (ref === "k-pay" ? [{ ...live(ref), status: "CANCELLED" }] : []));
    const { adapter } = makePair({ fetch: cancelledOnly.fetch });
    expect(((await adapter.retrievePayment("pay_1")).raw as { settlements: unknown[] }).settlements).toEqual([
      expect.objectContaining({ id: "stl_k-pay", status: "CANCELLED" }),
    ]);
    const err = await rejection(adapter.refundPayment({ pspPaymentId: "pay_1", idempotencyKey: "k-refund" }));
    expect(err.message).toContain("its settlements moved no money (failed, cancelled or expired)");
  });

  it("reads only the records filed under the reference it looked up", async () => {
    const payment = { id: "pay_1", merchantRefNum: "k-pay", status: "COMPLETED", amount: 1000, currencyCode: "USD", settleWithAuth: true };
    const stub = oneParkedPayment(payment, () => [
      { id: "stl_other", merchantRefNum: "k-pay-2", status: "COMPLETED", amount: 1000, availableToRefund: 1000 },
    ]);
    const { adapter } = makePair({ fetch: stub.fetch });
    expect(await adapter.retrievePayment("pay_1")).toMatchObject({ amountCaptured: 1000, amountRefunded: 0 });
    expect(((await adapter.retrievePayment("pay_1")).raw as { settlements: unknown[] }).settlements).toEqual([]);
    await expect(adapter.refundPayment({ pspPaymentId: "pay_1", idempotencyKey: "k-refund" })).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(stub.posts).toEqual([]);
  });
});

describe("Paysafe refund refusals", () => {
  it("names a payment that failed, was cancelled or expired, and offers a cancel only while something is left to capture", async () => {
    for (const [status, outcome] of [
      ["FAILED", "it failed"],
      ["ERROR", "it failed"],
      ["CANCELLED", "it was cancelled"],
      // Not a documented payment status (a settlement's and a refund's), read all the same.
      ["EXPIRED", "it expired"],
    ] as const) {
      const stub = oneParkedPayment({ id: "pay_1", merchantRefNum: "k-pay", status, amount: 1000, currencyCode: "USD", settleWithAuth: false, availableToSettle: 1000 });
      const err = await rejection(makePair({ fetch: stub.fetch }).adapter.refundPayment({ pspPaymentId: "pay_1", idempotencyKey: "k-refund" }));
      expect(err.message, status).toBe(`Payment pay_1 has no refundable settlement: ${outcome}, so it settled nothing`);
      expect(stub.lookedUp, status).toEqual([]);
    }
  });

  it("says what the payment's state leaves as causes", async () => {
    const base = { id: "pay_1", merchantRefNum: "k-pay", status: "COMPLETED", amount: 1000, currencyCode: "USD" };
    const cases: Array<[string, Record<string, unknown>, Array<Record<string, unknown>>, string[], string[]]> = [
      ["authorized", { settleWithAuth: false, availableToSettle: 1000 }, [], ["it is only authorized (cancel it instead)"], ["captured in part", "lookup"]],
      [
        "captured by an earlier release",
        { settleWithAuth: false, availableToSettle: 0 },
        [],
        ["it was captured in part, or by an earlier release of this adapter", "does not show its settlement yet", "Refund such a settlement in the Paysafe portal"],
        ["only authorized"],
      ],
      [
        "settled with its authorization, out of the lookup's sight",
        { settleWithAuth: true, availableToSettle: 0 },
        [],
        ["Paysafe's settlement lookup does not show its settlement yet, or does not reach back to it"],
        ["only authorized", "captured in part", "Paysafe portal"],
      ],
      [
        "settled with its authorization, every settlement expired",
        { settleWithAuth: true, availableToSettle: 0 },
        [{ id: "stl_1", merchantRefNum: "k-pay", status: "EXPIRED", amount: 1000, availableToRefund: 1000 }],
        ["its settlements moved no money (failed, cancelled or expired)", "does not show its settlement yet"],
        ["only authorized", "captured in part"],
      ],
      [
        "settled with its authorization, refunded in full",
        { settleWithAuth: true, availableToSettle: 0 },
        [{ id: "stl_1", merchantRefNum: "k-pay", status: "COMPLETED", amount: 1000, availableToRefund: 0, refundedAmount: 1000 }],
        ["the settlement it has is not refundable yet (still in flight, or the sandbox settlement batch has not run) or already refunded in full"],
        ["only authorized", "lookup", "captured in part", ";"],
      ],
      [
        "still processing, its settlement in flight",
        { status: "PROCESSING", settleWithAuth: true },
        [{ id: "stl_1", merchantRefNum: "k-pay", status: "PROCESSING", amount: 1000, availableToRefund: 0 }],
        ["the settlement it has is not refundable yet (still in flight, or the sandbox settlement batch has not run)"],
        ["only authorized", "lookup", "has not completed"],
      ],
      ["still processing, no settlement yet", { status: "HELD", settleWithAuth: true }, [], ["it has not completed yet"], ["lookup", "only authorized"]],
      ["authorized for nothing", { amount: 0, settleWithAuth: false, availableToSettle: 0 }, [], [], [":"]],
      [
        // A full capture takes all that remains, whatever a trailing read still shows left to settle.
        "captured in full and refunded, the read still showing the authorization",
        { settleWithAuth: false, availableToSettle: 1000 },
        [{ id: "stl_1", merchantRefNum: "payfanout-capture-pay_1", status: "COMPLETED", amount: 1000, availableToRefund: 0, refundedAmount: 1000 }],
        ["the settlement it has is not refundable yet (still in flight, or the sandbox settlement batch has not run) or already refunded in full"],
        ["only authorized", "captured in part", "lookup", ";"],
      ],
    ];
    for (const [label, fields, settlements, present, absent] of cases) {
      const stub = oneParkedPayment({ ...base, ...fields }, (ref) => settlements.filter((s) => s["merchantRefNum"] === ref));
      const err = await rejection(makePair({ fetch: stub.fetch }).adapter.refundPayment({ pspPaymentId: "pay_1", idempotencyKey: "k-refund" }));
      expect(err, label).toMatchObject({ code: "invalid_request", retryable: false });
      expect(err.message, label).toMatch(/^Payment pay_1 has no refundable settlement/);
      for (const text of present) expect(err.message, label).toContain(text);
      for (const text of absent) expect(err.message, label).not.toContain(text);
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

  it("starts every settlement read the day before the payment, asks for 50 records, and leaves the replay reads on the default window", async () => {
    const { adapter, fake } = makePair();
    const paid = await complete(adapter, "automatic");
    const authorized = await complete(adapter, "manual");
    const another = await complete(adapter, "manual", 2000, "USD", "k-manual-2");
    // The capture's answer is lost, so it is read back under its key.
    fake.loseAnswer(SETTLE);
    await adapter.capturePayment(authorized, 700, "k-capture");
    const reads = {
      retrievePayment: () => adapter.retrievePayment(paid),
      refundPayment: () => adapter.refundPayment({ pspPaymentId: paid, amount: 100, idempotencyKey: "k-refund" }),
      cancelPayment: () => adapter.cancelPayment(authorized, "k-void"),
      capturePayment: () => adapter.capturePayment(another, undefined, "k-capture-full"),
    };
    for (const [name, read] of Object.entries(reads)) {
      const before = fake.requests.length;
      await read();
      const lookups = lookupsIn(fake.requests.slice(before));
      expect(lookups.length, name).toBeGreaterThan(0);
      // The payments were made on 2026-07-04, at 10:00 UTC.
      for (const lookup of lookups) {
        expect(lookup.get("startDate"), name).toBe("2026-07-03");
        expect(lookup.get("limit"), name).toBe("50");
      }
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
      expect(starts, String(txnTime)).toEqual([expected]);
    }
  });

  it("sends no start date for a payment whose txnTime is missing or unreadable, and still finds a recent settlement", async () => {
    // 1e10 falls below the epoch milliseconds the adapter reads; a year past four digits has no YYYY-MM-DD form.
    for (const txnTime of [undefined, "not-a-date", 1e10, "+010000-01-02T00:00:00Z"]) {
      const fake = new FakePaysafeApi();
      const { adapter } = makePair({
        fetch: async (input, init) => {
          const response = await fake.fetch(input, init);
          if ((init?.method ?? "GET") !== "GET" || !PAYMENT_PATH.test(new URL(urlOf(input)).pathname)) return response;
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

  it("leaves a settlement the default window no longer shows out of reach when Paysafe refuses the range", async () => {
    const { adapter, fake } = makePair();
    fake.lookupRangeLimitDays = 40;
    const id = await complete(adapter, "automatic");
    fake.passDays(45);
    const err = await rejection(adapter.refundPayment({ pspPaymentId: id, idempotencyKey: "k-refund" }));
    expect(err).toMatchObject({ code: "invalid_request", message: expect.stringMatching(/no refundable settlement/) });
    // The reference is asked with the range, then without it.
    expect(settlementLookups(fake).map((params) => [params.get("merchantRefNum"), params.get("startDate")])).toEqual([
      ["k-automatic", "2026-07-03"],
      ["k-automatic", null],
    ]);
    expect(fake.uniqueRefundCreations).toBe(0);
  });

  it("reads past a reference that only looks empty once Paysafe refuses the range, to the full capture after it", async () => {
    const { adapter, fake } = makePair();
    // Paysafe documents no widest range; the double refuses one past 20 days.
    fake.lookupRangeLimitDays = 20;
    const id = await complete(adapter, "manual");
    const idle = await complete(adapter, "manual", 2000, "USD", "k-manual-idle");
    const refs = fullCaptureRefs(id);
    // Day 0: a full capture fails under the first reference.
    fake.recordFailure(SETTLE, GATEWAY_REJECTION);
    await rejection(adapter.capturePayment(id, undefined, "k-capture"));
    // Day 6: the ranged walk still shows that failure, so the retry settles under the second.
    fake.passDays(6);
    const captured = await adapter.capturePayment(id, undefined, "k-capture");
    expect(captureSettlementOf(captured)).toMatchObject({ merchantRefNum: refs[1], amount: 2000 });
    // Day 34: the range is refused, and the default window no longer shows the failure.
    fake.passDays(28);
    const lookedUp = async <T>(call: () => Promise<T>): Promise<[T, Array<[string | null, string | null]>]> => {
      const before = fake.requests.length;
      const result = await call();
      return [result, lookupsIn(fake.requests.slice(before)).map((params) => [params.get("merchantRefNum"), params.get("startDate")])];
    };
    const [refund, refundLookups] = await lookedUp(() =>
      adapter.refundPayment({ pspPaymentId: id, amount: 500, idempotencyKey: "k-refund" }),
    );
    expect(refund).toMatchObject({ status: "succeeded", amount: 500 });
    // The refused range is not asked for again on the next reference.
    expect(refundLookups).toEqual([[refs[0], "2026-07-03"], [refs[0], null], [refs[1], null]]);
    expect(await adapter.retrievePayment(id)).toMatchObject({
      status: "succeeded",
      amountCaptured: 2000,
      amountRefunded: 500,
      capturedAt: "2026-07-10T10:05:00.000Z",
    });
    // A full capture reads the references the same way, and answers with that settlement, sending nothing.
    const again = await adapter.capturePayment(id, undefined, "k-capture-again");
    expect(captureSettlementOf(again)).toMatchObject({ merchantRefNum: refs[1], amount: 2000 });
    expect(sent(fake, SETTLE).map((r) => r.body?.["merchantRefNum"])).toEqual(refs.slice(0, 2));
    // Where nothing shows, the read walks all ten references, and no more.
    const [read, idleLookups] = await lookedUp(() => adapter.retrievePayment(idle));
    expect(read).toMatchObject({ status: "requires_capture", amountCaptured: 0, amountCapturable: 2000 });
    const idleRefs = fullCaptureRefs(idle);
    expect(idleLookups).toEqual([[idleRefs[0], "2026-07-03"], ...idleRefs.map((ref): [string, null] => [ref, null])]);
    // A full capture then still settles under the first empty reference.
    await adapter.capturePayment(idle, undefined, "k-capture-idle");
    expect(sent(fake, SETTLE).at(-1)?.body).toEqual({ merchantRefNum: fullCaptureRefs(idle)[0], dupCheck: true, amount: 2000 });
  });

  it("settles after the last reference holding records once Paysafe refuses the range, not under one that only looks empty", async () => {
    const { adapter, fake } = makePair();
    fake.lookupRangeLimitDays = 20;
    const id = await complete(adapter, "manual");
    const refs = fullCaptureRefs(id);
    // Day 0: a full capture fails under the first reference.
    fake.recordFailure(SETTLE, GATEWAY_REJECTION);
    await rejection(adapter.capturePayment(id, undefined, "k-capture-1"));
    // Day 25: the default window still shows that failure, so the retry settles, and fails, under the second.
    fake.passDays(25);
    fake.recordFailure(SETTLE, GATEWAY_REJECTION);
    await rejection(adapter.capturePayment(id, undefined, "k-capture-2"));
    expect(sent(fake, SETTLE).map((r) => r.body?.["merchantRefNum"])).toEqual(refs.slice(0, 2));
    // Day 40: the default window no longer shows the first failure, but still the second, so the first only looks empty.
    fake.passDays(15);
    const captured = await adapter.capturePayment(id, undefined, "k-capture-3");
    expect(captureSettlementOf(captured)).toMatchObject({ merchantRefNum: refs[2], amount: 2000 });
    expect(captured).toMatchObject({ status: "succeeded", amountCaptured: 2000 });
  });

  it("carries a range refused on the payment's own reference into the walk, asking for it no more", async () => {
    // A payment that states no settleWithAuth reads its own reference first.
    const payment = { id: "pay_1", merchantRefNum: "k-pay", status: "COMPLETED", amount: 1000, availableToSettle: 1000, currencyCode: "USD", txnTime: "2026-07-04T10:00:00Z" };
    const lookups: Array<[string | null, string | null]> = [];
    const { adapter } = makePair({
      fetch: async (input) => {
        const url = new URL(urlOf(input));
        if (url.pathname !== SETTLEMENTS) return new Response(JSON.stringify(payment));
        lookups.push([url.searchParams.get("merchantRefNum"), url.searchParams.get("startDate")]);
        if (url.searchParams.has("startDate")) {
          return new Response(JSON.stringify({ error: { code: "5068", message: "Field error(s)" } }), { status: 400 });
        }
        return new Response(JSON.stringify({ settlements: [] }));
      },
    });
    expect(await adapter.retrievePayment("pay_1")).toMatchObject({ status: "requires_capture", amountCapturable: 1000 });
    const refs = fullCaptureRefs("pay_1");
    expect(lookups).toEqual([["k-pay", "2026-07-03"], ["k-pay", null], ...refs.map((ref): [string, null] => [ref, null])]);
  });

  it("reads on past empty references for the rest of a walk once any of its lookups has fallen back", async () => {
    const payment = { id: "pay_1", merchantRefNum: "k-pay", status: "COMPLETED", amount: 1000, availableToSettle: 0, currencyCode: "USD", settleWithAuth: false, txnTime: "2026-07-04T10:00:00Z" };
    const [first, second, third] = fullCaptureRefs("pay_1");
    const live = { id: "stl_3", merchantRefNum: third, status: "COMPLETED", amount: 1000, availableToRefund: 1000, txnTime: "2026-07-05T10:00:00Z" };
    const lookups: Array<[string | null, string | null]> = [];
    const { adapter } = makePair({
      fetch: async (input) => {
        const url = new URL(urlOf(input));
        if (url.pathname !== SETTLEMENTS) return new Response(JSON.stringify(payment));
        const ref = url.searchParams.get("merchantRefNum");
        const ranged = url.searchParams.has("startDate");
        lookups.push([ref, url.searchParams.get("startDate")]);
        // The first refuses the range; the second answers it as an unknown reference; the third holds the capture.
        if (ranged && ref === first) return new Response(JSON.stringify({ error: { code: "5068", message: "Field error(s)" } }), { status: 400 });
        if (ref === second) return new Response(JSON.stringify({ error: { code: "5269", message: "Entity not found" } }), { status: 404 });
        return new Response(JSON.stringify({ settlements: ref === third ? [live] : [] }));
      },
    });
    expect(await adapter.retrievePayment("pay_1")).toMatchObject({ status: "succeeded", amountCaptured: 1000, capturedAt: "2026-07-05T10:00:00.000Z" });
    expect(lookups).toEqual([[first, "2026-07-03"], [first, null], [second, null], [third, null]]);
  });

  it("fails a read, a refund and a full capture when a lookup fails, instead of reading it as no settlement", async () => {
    for (const [status, code] of [[503, "psp_unavailable"], [429, "rate_limited"]] as const) {
      const { adapter, fake } = makePair();
      const paid = await complete(adapter, "automatic");
      const authorized = await complete(adapter, "manual");
      const calls = {
        retrievePayment: () => adapter.retrievePayment(paid),
        refundPayment: () => adapter.refundPayment({ pspPaymentId: paid, amount: 100, idempotencyKey: "k-refund" }),
        capturePayment: () => adapter.capturePayment(authorized, undefined, "k-capture"),
      };
      for (const [name, call] of Object.entries(calls)) {
        const before = fake.requests.length;
        // Every attempt of the lookup fails (1 + maxNetworkRetries).
        fake.refuse({ method: "GET", path: SETTLEMENTS }, status, 3);
        const err = await rejection(call());
        const label = `${status} ${name}`;
        expect(err, label).toMatchObject({ code, retryable: true });
        // The lookup is not sent again without its start date, and nothing is written.
        const lookups = lookupsIn(fake.requests.slice(before));
        expect(lookups.map((params) => params.get("startDate")), label).toEqual(["2026-07-03", "2026-07-03", "2026-07-03"]);
        expect(fake.requests.slice(before).filter((r) => r.method === "POST"), label).toEqual([]);
      }
    }
  });

  it("fails a cancel's answer when the lookup after its void fails, and its replay answers with that void", async () => {
    const { adapter, fake } = makePair();
    const id = await complete(adapter, "manual");
    await adapter.capturePayment(id, 700, "k-capture-part");
    fake.refuse({ method: "GET", path: SETTLEMENTS }, 503, 3);
    await expect(adapter.cancelPayment(id, "k-void")).rejects.toMatchObject({ code: "psp_unavailable", retryable: true });
    expect(await adapter.cancelPayment(id, "k-void")).toMatchObject({
      status: "succeeded",
      amount: 700,
      amountCaptured: 700,
      amountCapturable: 0,
    });
    expect(sent(fake, VOID)).toHaveLength(1);
  });

  it("throws the failure of the lookup sent again without a start date after a refused range", async () => {
    for (const [unranged, code] of [[400, "invalid_request"], [503, "psp_unavailable"]] as const) {
      const fake = new FakePaysafeApi();
      const starts: Array<string | null> = [];
      const { adapter } = makePair({
        fetch: async (input, init) => {
          const url = new URL(urlOf(input));
          if (url.pathname !== SETTLEMENTS) return fake.fetch(input, init);
          starts.push(url.searchParams.get("startDate"));
          // Past what the adapter may send, a not-found answer ends any loop of lookups.
          if (starts.length > 10) return new Response(JSON.stringify({ error: { code: "5269" } }), { status: 404 });
          const status = url.searchParams.has("startDate") ? 400 : unranged;
          const error = status === 400 ? { code: "5068", message: "Field error(s)" } : { code: "1000", message: "An internal error occurred." };
          return new Response(JSON.stringify({ error }), { status });
        },
      });
      const id = await complete(adapter, "automatic");
      const err = await rejection(adapter.refundPayment({ pspPaymentId: id, idempotencyKey: "k-refund" }));
      expect(err, String(unranged)).toMatchObject({ code, raw: { error: { code: unranged === 400 ? "5068" : "1000" } } });
      // One ranged attempt, refused; then the unranged lookup, with its GET retries on a 5xx.
      expect(starts, String(unranged)).toEqual(unranged === 400 ? ["2026-07-03", null] : ["2026-07-03", null, null, null]);
      expect(fake.uniqueRefundCreations).toBe(0);
    }
  });

  it("reads a not-found answer to a ranged lookup as no settlement under that reference, without asking again", async () => {
    for (const captureMethod of ["automatic", "manual"] as const) {
      const fake = new FakePaysafeApi();
      const lookups: Array<[string | null, string | null]> = [];
      const { adapter } = makePair({
        fetch: async (input, init) => {
          const url = new URL(urlOf(input));
          if (url.pathname !== SETTLEMENTS) return fake.fetch(input, init);
          lookups.push([url.searchParams.get("merchantRefNum"), url.searchParams.get("startDate")]);
          return new Response(JSON.stringify({ error: { code: "5269", message: "Entity not found" } }), { status: 404 });
        },
      });
      const id = await complete(adapter, captureMethod);
      const err = await rejection(adapter.refundPayment({ pspPaymentId: id, idempotencyKey: "k-refund" }));
      expect(err.message, captureMethod).toMatch(/no refundable settlement/);
      expect(lookups, captureMethod).toEqual([
        [captureMethod === "automatic" ? "k-automatic" : `payfanout-capture-${id}`, "2026-07-03"],
      ]);
    }
  });
});
