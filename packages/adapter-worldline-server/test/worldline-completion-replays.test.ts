import { describe, expect, it } from "vitest";
import {
  getUserMessage,
  type CreatePaymentSessionInput,
  type PayFanoutError,
  type PaymentInfo,
  type UnifiedErrorCode,
} from "@payfanout/core";
import {
  deriveIdempotenceKey,
  WorldlineServerAdapter,
  type WorldlinePaymentLike,
  type WorldlineServerAdapterConfig,
} from "../src/index.js";
import { FakeWorldlineApi } from "./fake-worldline-api.js";

const HOST_KEY = "complete-order-42";
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const REPLAY_HEADER = "X-GCS-Idempotence-Request-Timestamp";

function makeAdapter(fetchImpl: typeof fetch, config: Partial<WorldlineServerAdapterConfig> = {}): WorldlineServerAdapter {
  return new WorldlineServerAdapter({
    apiKeyId: "api-key-id",
    secretApiKey: "secret-api-key",
    merchantId: "mid-1",
    environment: "sandbox",
    sessionSigningKey: "session-signing-key",
    webhookKeys: [{ keyId: "wh-key-1", secretKey: "webhook-secret" }],
    defaultReturnUrl: "https://host.example/return",
    sleep: async () => {},
    fetch: fetchImpl,
    ...config,
  });
}

function makePair(config: Partial<WorldlineServerAdapterConfig> = {}) {
  const fake = new FakeWorldlineApi();
  return { fake, adapter: makeAdapter(fake.fetch, config) };
}

async function openSession(
  adapter: WorldlineServerAdapter,
  overrides: Partial<CreatePaymentSessionInput> = {},
): Promise<string> {
  const session = await adapter.createPaymentSession({ amount: 2500, currency: "EUR", idempotencyKey: "session-1", ...overrides });
  return session.pspSessionId;
}

/** A session and the hosted tokenization id the fake issued for it, which the browser sends back once the card is in. */
async function openTokenizedSession(adapter: WorldlineServerAdapter): Promise<{ pspSessionId: string; hostedTokenizationId: string }> {
  const session = await adapter.createPaymentSession({ amount: 2500, currency: "EUR", idempotencyKey: "session-1" });
  return { pspSessionId: session.pspSessionId, hostedTokenizationId: session.clientSecret!.split("/").pop()! };
}

function complete(adapter: WorldlineServerAdapter, pspSessionId: string, clientToken: string): Promise<PaymentInfo> {
  return adapter.completePayment({ pspSessionId, clientToken, idempotencyKey: HOST_KEY });
}

function rejection(pending: Promise<unknown>): Promise<PayFanoutError> {
  return pending.then(
    () => {
      throw new Error("expected the completion to reject");
    },
    (err: unknown) => err as PayFanoutError,
  );
}

/** The payment a 402 decline reports in its paymentResult. */
function declinedPaymentId(error: PayFanoutError): string {
  return (error.raw as { paymentResult: { payment: { id: string } } }).paymentResult.payment.id;
}

/** The key the host key's first attempt goes out under, or the one after a failed attempt. */
function keyAfter(attemptId?: string): Promise<string> {
  return deriveIdempotenceKey(attemptId === undefined ? HOST_KEY : `${HOST_KEY}:after:${attemptId}`);
}

/** The CreatePayment sends the fake saw: each one's key, and whether it replayed a stored answer. */
function sends(fake: FakeWorldlineApi): Array<[string | undefined, boolean]> {
  return fake.createPaymentLog.map(({ idemKey, replayed }) => [idemKey, replayed]);
}

function redirectUrl(info: PaymentInfo): string | undefined {
  return (info.raw as { merchantAction?: { redirectData?: { redirectURL?: string } } }).merchantAction?.redirectData
    ?.redirectURL;
}

/** Relays to the fake, rewriting the replay header on every answer that carries one. */
function rewritingReplayHeader(fake: FakeWorldlineApi, value: string, name = REPLAY_HEADER): typeof fetch {
  return async (input, init) => {
    const response = await fake.fetch(input, init);
    if (!response.headers.has(REPLAY_HEADER)) return response;
    const headers = new Headers({ "content-type": "application/json" });
    headers.set(name, value);
    return new Response(await response.text(), { status: response.status, headers });
  };
}

/** Relays to the fake, recording every CreatePayment key sent and answering the next ones itself when told to. */
function interceptingFetch(fake: FakeWorldlineApi) {
  const sent: string[] = [];
  let intercepted: { remaining: number; answer: () => Response } | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    if (init?.method === "POST" && String(input).endsWith("/payments")) {
      sent.push((init.headers as Record<string, string>)["X-GCS-Idempotence-Key"] ?? "");
      if (intercepted && intercepted.remaining > 0) {
        intercepted.remaining--;
        return intercepted.answer();
      }
    }
    return fake.fetch(input, init);
  };
  return {
    fetchImpl,
    sent,
    answerNext: (remaining: number, answer: () => Response) => {
      intercepted = { remaining, answer };
    },
  };
}

/** How one CreatePayment runs, given the request to the fake. */
type CreatePaymentStep = (send: () => Promise<Response>) => Promise<Response>;

/** Processed, then the connection fails before the answer arrives. */
const loseAnswer: CreatePaymentStep = async (send) => {
  await send();
  throw new TypeError("simulated connection reset after the request was processed");
};

const relay: CreatePaymentStep = (send) => send();

/** The answer, with its replay header set to `value`. */
function withReplayHeader(value: string): CreatePaymentStep {
  return async (send) => {
    const response = await send();
    const headers = new Headers(response.headers);
    headers.set(REPLAY_HEADER, value);
    return new Response(await response.text(), { status: response.status, headers });
  };
}

/** The answer, its payment (a 2xx's, or a refusal's paymentResult) showing `fields` in place of its own. */
function showingPayment(fields: Partial<WorldlinePaymentLike>): CreatePaymentStep {
  return async (send) => {
    const response = await send();
    const body = (await response.json()) as { payment?: object; paymentResult?: { payment?: object } };
    if (body.payment) body.payment = { ...body.payment, ...fields };
    if (body.paymentResult?.payment) body.paymentResult.payment = { ...body.paymentResult.payment, ...fields };
    return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
  };
}

/**
 * Relays to the fake. The next CreatePayments run through the steps given to
 * `script`, in order, and a payment given to `readBackAs` reads back with the
 * fields given in place of its own.
 */
function scriptedFetch(fake: FakeWorldlineApi) {
  const steps: CreatePaymentStep[] = [];
  const reads = new Map<string, Partial<WorldlinePaymentLike>>();
  const fetchImpl: typeof fetch = async (input, init) => {
    const send = () => fake.fetch(input, init);
    const path = new URL(String(input)).pathname;
    if (init?.method === "POST" && path.endsWith("/payments")) return (steps.shift() ?? relay)(send);
    const read = /\/payments\/([^/]+)$/.exec(path);
    const fields = read && init?.method === "GET" ? reads.get(decodeURIComponent(read[1]!)) : undefined;
    if (!fields) return send();
    const response = await send();
    return new Response(JSON.stringify({ ...((await response.json()) as object), ...fields }), {
      status: response.status,
      headers: response.headers,
    });
  };
  return {
    fetchImpl,
    script: (...next: CreatePaymentStep[]) => void steps.push(...next),
    readBackAs: (paymentId: string, fields: Partial<WorldlinePaymentLike>) => void reads.set(paymentId, fields),
  };
}

/** What a payment Worldline cancelled as an authorisation reads (Statuses reference, CancelPayment). */
const AUTHORISED_AND_CANCELLED: Partial<WorldlinePaymentLike> = {
  status: "CANCELLED",
  statusOutput: { statusCode: 6, statusCategory: "UNSUCCESSFUL" },
};

/** A transient answer dressed as a replayed decline: the header, and a failed payment in paymentResult. */
function transientAnswer(status: number): Response {
  const body = {
    errorId: `transient-${status}`,
    errors: [{ errorCode: status === 409 ? "1409" : "30511001", httpStatusCode: status }],
    paymentResult: {
      payment: { id: "pay_elsewhere", status: "REJECTED", statusOutput: { statusCode: 2, statusCategory: "UNSUCCESSFUL" } },
    },
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", [REPLAY_HEADER]: String(Date.now() - HOUR) },
  });
}

describe("completing again under a key whose attempt failed", () => {
  it("sends the next card under the key after the declined attempt, and creates exactly one more payment", async () => {
    const { adapter, fake } = makePair();
    fake.declinedCards.add("htp_declined");
    const session = await openSession(adapter);
    const declined = await rejection(complete(adapter, session, "htp_declined"));
    expect(declined).toMatchObject({ code: "card_declined", retryable: false });
    expect(declined.outcomeUnknown).toBeUndefined();
    const firstAttempt = declinedPaymentId(declined);

    const paid = await complete(adapter, session, "htp_new_card");
    expect(paid).toMatchObject({ status: "succeeded", amount: 2500, currency: "EUR" });
    expect(fake.uniquePaymentCreations).toBe(2);
    const [linkZero, linkOne] = await Promise.all([keyAfter(), keyAfter(firstAttempt)]);
    expect(sends(fake)).toEqual([
      [linkZero, false],
      [linkZero, true],
      [linkOne, false],
    ]);
    expect(fake.paymentIdUnder(linkZero)).toBe(firstAttempt);
    expect(fake.paymentIdUnder(linkOne)).toBe(paid.pspPaymentId);
    expect(fake.lastCreatePaymentBody?.["hostedTokenizationId"]).toBe("htp_new_card");
  });

  it("walks two declines to the third attempt", async () => {
    const { adapter, fake } = makePair();
    fake.declinedCards.add("htp_declined_1");
    fake.declinedCards.add("htp_declined_2");
    const session = await openSession(adapter);
    const first = await rejection(complete(adapter, session, "htp_declined_1"));
    const second = await rejection(complete(adapter, session, "htp_declined_2"));
    expect(second).toMatchObject({ code: "card_declined", retryable: false });
    expect(declinedPaymentId(second)).not.toBe(declinedPaymentId(first));

    const paid = await complete(adapter, session, "htp_new_card");
    expect(paid.status).toBe("succeeded");
    expect(fake.uniquePaymentCreations).toBe(3);
    const [linkZero, linkOne, linkTwo] = await Promise.all([
      keyAfter(),
      keyAfter(declinedPaymentId(first)),
      keyAfter(declinedPaymentId(second)),
    ]);
    expect(sends(fake)).toEqual([
      [linkZero, false],
      [linkZero, true],
      [linkOne, false],
      [linkZero, true],
      [linkOne, true],
      [linkTwo, false],
    ]);
    expect(fake.paymentIdUnder(linkTwo)).toBe(paid.pspPaymentId);
  });

  it("returns the payment again when a completion is repeated after a success, whatever card it carries", async () => {
    const { adapter, fake } = makePair();
    const session = await openSession(adapter);
    const paid = await complete(adapter, session, "htp_card");
    const again = await complete(adapter, session, "htp_other_card");
    expect(again).toMatchObject({ status: "succeeded", pspPaymentId: paid.pspPaymentId });
    expect(fake.uniquePaymentCreations).toBe(1);
    const linkZero = await keyAfter();
    expect(sends(fake)).toEqual([
      [linkZero, false],
      [linkZero, true],
    ]);
  });

  it("returns the later attempt's payment when a completion is repeated after the walk succeeded", async () => {
    const { adapter, fake } = makePair();
    fake.declinedCards.add("htp_declined");
    const session = await openSession(adapter);
    const declined = await rejection(complete(adapter, session, "htp_declined"));
    const paid = await complete(adapter, session, "htp_new_card");
    const again = await complete(adapter, session, "htp_third_card");
    expect(again).toMatchObject({ status: "succeeded", pspPaymentId: paid.pspPaymentId });
    expect(fake.uniquePaymentCreations).toBe(2);
    const [linkZero, linkOne] = await Promise.all([keyAfter(), keyAfter(declinedPaymentId(declined))]);
    expect(sends(fake).slice(3)).toEqual([
      [linkZero, true],
      [linkOne, true],
    ]);
  });

  const currencies: Array<[number, string]> = [
    [500, "JPY"],
    [1234, "BHD"],
  ];
  for (const [amount, currency] of currencies) {
    it(`sends the next attempt with the session's ${currency} amount in integer minor units`, async () => {
      const { adapter, fake } = makePair();
      fake.declinedCards.add("htp_declined");
      const session = await openSession(adapter, { amount, currency });
      await rejection(complete(adapter, session, "htp_declined"));
      const paid = await complete(adapter, session, "htp_new_card");
      expect(paid).toMatchObject({ status: "succeeded", amount, currency });
      const order = fake.lastCreatePaymentBody?.["order"] as { amountOfMoney?: unknown } | undefined;
      expect(order?.amountOfMoney).toEqual({ amount, currencyCode: currency });
    });
  }
});

describe("a replayed attempt that did not fail", () => {
  it("never authorises a repeated manual-capture completion twice", async () => {
    const { adapter, fake } = makePair();
    const session = await openSession(adapter, { captureMethod: "manual" });
    const authorised = await complete(adapter, session, "htp_card");
    expect(authorised.status).toBe("requires_capture");
    const again = await complete(adapter, session, "htp_other_card");
    expect(again).toMatchObject({ status: "requires_capture", pspPaymentId: authorised.pspPaymentId });
    expect(fake.uniquePaymentCreations).toBe(1);
    const linkZero = await keyAfter();
    expect(sends(fake)).toEqual([
      [linkZero, false],
      [linkZero, true],
    ]);
  });

  it("returns an authorisation the merchant cancelled since as it now reads, and sends no new attempt", async () => {
    const { adapter, fake } = makePair();
    const session = await openSession(adapter, { captureMethod: "manual" });
    const authorised = await complete(adapter, session, "htp_card");
    await adapter.cancelPayment(authorised.pspPaymentId, "cancel-order-42");
    const again = await complete(adapter, session, "htp_other_card");
    expect(again).toMatchObject({ status: "canceled", pspPaymentId: authorised.pspPaymentId });
    expect(fake.uniquePaymentCreations).toBe(1);
  });

  for (const code of [50, 51, 52] as const) {
    it(`returns a payment still pending at ${code} as processing, whatever card the repeat carries`, async () => {
      const { adapter, fake } = makePair();
      fake.pendingCards.set("htp_pending", code);
      const session = await openSession(adapter);
      const pending = await complete(adapter, session, "htp_pending");
      expect(pending.status).toBe("processing");
      const again = await complete(adapter, session, "htp_new_card");
      expect(again).toMatchObject({ status: "processing", pspPaymentId: pending.pspPaymentId });
      expect(fake.uniquePaymentCreations).toBe(1);
      expect(sends(fake).map(([, replayed]) => replayed)).toEqual([false, true]);
    });
  }

  const settled: Array<["automatic" | "manual", string]> = [
    ["automatic", "succeeded"],
    ["manual", "requires_capture"],
  ];
  for (const [captureMethod, status] of settled) {
    it(`returns a pending ${captureMethod}-capture payment that went through as it now reads, ${status}`, async () => {
      const { adapter, fake } = makePair();
      fake.pendingCards.set("htp_pending", 50);
      const session = await openSession(adapter, { captureMethod });
      const pending = await complete(adapter, session, "htp_pending");
      fake.settlePendingAuthorization(pending.pspPaymentId, "succeeded");
      const again = await complete(adapter, session, "htp_new_card");
      expect(again).toMatchObject({ status, pspPaymentId: pending.pspPaymentId });
      expect(fake.uniquePaymentCreations).toBe(1);
    });
  }

  it("moves on once a payment that was pending when created has failed", async () => {
    const { adapter, fake } = makePair();
    fake.pendingCards.set("htp_pending", 51);
    const session = await openSession(adapter);
    const pending = await complete(adapter, session, "htp_pending");
    fake.settlePendingAuthorization(pending.pspPaymentId, "rejected");

    const paid = await complete(adapter, session, "htp_new_card");
    expect(paid.status).toBe("succeeded");
    expect(paid.pspPaymentId).not.toBe(pending.pspPaymentId);
    expect(fake.uniquePaymentCreations).toBe(2);
    const [linkZero, linkOne] = await Promise.all([keyAfter(), keyAfter(pending.pspPaymentId)]);
    expect(sends(fake)).toEqual([
      [linkZero, false],
      [linkZero, true],
      [linkOne, false],
    ]);
  });
});

describe("a replayed 3-D Secure challenge", () => {
  for (const outcome of ["rejected", "cancelled"] as const) {
    it(`is walked past once its payment is ${outcome}`, async () => {
      const { adapter, fake } = makePair();
      const session = await openSession(adapter);
      const challenge = await complete(adapter, session, "htp_3ds");
      expect(challenge.status).toBe("requires_action");
      fake.settleChallenge(challenge.pspPaymentId, outcome);

      const paid = await complete(adapter, session, "htp_new_card");
      expect(paid.status).toBe("succeeded");
      expect(paid.pspPaymentId).not.toBe(challenge.pspPaymentId);
      expect(fake.uniquePaymentCreations).toBe(2);
      const [linkZero, linkOne] = await Promise.all([keyAfter(), keyAfter(challenge.pspPaymentId)]);
      expect(sends(fake)).toEqual([
        [linkZero, false],
        [linkZero, true],
        [linkOne, false],
      ]);
    });
  }

  // The Statuses reference lists CANCELLED with 1, 6, 61, 62, 64, 75 and 96, and describes none of 64, 75 and 96.
  const held: Array<[string, Partial<WorldlinePaymentLike>]> = [
    ["code 64", { status: "CANCELLED", statusOutput: { statusCode: 64, statusCategory: "UNSUCCESSFUL" } }],
    ["code 75", { status: "CANCELLED", statusOutput: { statusCode: 75, statusCategory: "UNSUCCESSFUL" } }],
    ["code 96", { status: "CANCELLED", statusOutput: { statusCode: 96, statusCategory: "UNSUCCESSFUL" } }],
    ["no status code", { status: "CANCELLED", statusOutput: { statusCategory: "UNSUCCESSFUL" } }],
  ];
  for (const [label, fields] of held) {
    it(`is held, not walked past, once its payment reads cancelled with ${label}`, async () => {
      const fake = new FakeWorldlineApi();
      const wire = scriptedFetch(fake);
      const adapter = makeAdapter(wire.fetchImpl);
      const session = await openSession(adapter);
      const challenge = await complete(adapter, session, "htp_3ds");
      fake.settleChallenge(challenge.pspPaymentId, "cancelled");
      wire.readBackAs(challenge.pspPaymentId, fields);

      const again = await complete(adapter, session, "htp_new_card");
      expect(again).toMatchObject({ status: "canceled", pspPaymentId: challenge.pspPaymentId });
      expect(fake.uniquePaymentCreations).toBe(1);
    });
  }

  it("is returned again as requires_action, with its redirect, while the customer has not finished it", async () => {
    const { adapter, fake } = makePair();
    const session = await openSession(adapter);
    const challenge = await complete(adapter, session, "htp_3ds");
    const again = await complete(adapter, session, "htp_new_card");
    expect(again).toMatchObject({ status: "requires_action", pspPaymentId: challenge.pspPaymentId });
    expect(redirectUrl(again)).toBe(redirectUrl(challenge));
    expect(redirectUrl(again)).toContain(challenge.pspPaymentId);
    expect(fake.uniquePaymentCreations).toBe(1);
    expect(sends(fake).map(([, replayed]) => replayed)).toEqual([false, true]);
  });

  const settled: Array<["automatic" | "manual", string]> = [
    ["automatic", "succeeded"],
    ["manual", "requires_capture"],
  ];
  for (const [captureMethod, status] of settled) {
    it(`returns the payment as it now reads, ${status}, once the ${captureMethod}-capture challenge succeeded`, async () => {
      const { adapter, fake } = makePair();
      const session = await openSession(adapter, { captureMethod });
      const challenge = await complete(adapter, session, "htp_3ds");
      fake.settleChallenge(challenge.pspPaymentId, "succeeded");
      const again = await complete(adapter, session, "htp_new_card");
      expect(again).toMatchObject({ status, pspPaymentId: challenge.pspPaymentId });
      expect(redirectUrl(again)).toBeUndefined();
      expect(fake.uniquePaymentCreations).toBe(1);
    });
  }

  for (const code of [50, 51, 52] as const) {
    it(`returns a challenge handed on to an authorisation pending at ${code} as processing, and sends no new attempt`, async () => {
      const { adapter, fake } = makePair();
      const session = await openSession(adapter);
      const challenge = await complete(adapter, session, "htp_3ds");
      fake.settleChallenge(challenge.pspPaymentId, code);
      const again = await complete(adapter, session, "htp_new_card");
      expect(again).toMatchObject({ status: "processing", pspPaymentId: challenge.pspPaymentId });
      expect(redirectUrl(again)).toBeUndefined();
      expect(fake.uniquePaymentCreations).toBe(1);
    });
  }

  it("walks a decline and then a failed challenge to the third attempt", async () => {
    const { adapter, fake } = makePair();
    fake.declinedCards.add("htp_declined");
    const session = await openSession(adapter);
    const declined = await rejection(complete(adapter, session, "htp_declined"));
    const challenge = await complete(adapter, session, "htp_3ds");
    expect(challenge.status).toBe("requires_action");
    fake.settleChallenge(challenge.pspPaymentId, "rejected");

    const paid = await complete(adapter, session, "htp_new_card");
    expect(paid.status).toBe("succeeded");
    expect(fake.uniquePaymentCreations).toBe(3);
    const linkTwo = await keyAfter(challenge.pspPaymentId);
    expect(fake.paymentIdUnder(await keyAfter(declinedPaymentId(declined)))).toBe(challenge.pspPaymentId);
    expect(fake.paymentIdUnder(linkTwo)).toBe(paid.pspPaymentId);
  });
});

describe("a refusal whose payment had not finished", () => {
  /** A 402 whose paymentResult reports the payment Authorisation not known (52), the call's own. */
  async function refusedWhilePending() {
    const { adapter, fake } = makePair();
    fake.refusedWhilePending.set("htp_unknown", 52);
    const session = await openSession(adapter);
    const refused = await rejection(complete(adapter, session, "htp_unknown"));
    return { adapter, fake, session, refused, paymentId: declinedPaymentId(refused) };
  }

  it("is thrown marked outcomeUnknown, since the payment may still go through", async () => {
    const { refused } = await refusedWhilePending();
    expect(refused).toMatchObject({ code: "card_declined", retryable: false, outcomeUnknown: true });
  });

  it("holds the key while its replayed payment is still pending, sending no new attempt", async () => {
    const { adapter, fake, session, paymentId } = await refusedWhilePending();
    const again = await rejection(complete(adapter, session, "htp_new_card"));
    expect(again).toMatchObject({ code: "card_declined", retryable: false, outcomeUnknown: true });
    expect(declinedPaymentId(again)).toBe(paymentId);
    expect(fake.uniquePaymentCreations).toBe(1);
    expect(sends(fake).map(([, replayed]) => replayed)).toEqual([false, true]);
  });

  const settled: Array<["automatic" | "manual", string]> = [
    ["automatic", "succeeded"],
    ["manual", "requires_capture"],
  ];
  for (const [captureMethod, status] of settled) {
    it(`returns its ${captureMethod}-capture payment as it now reads, ${status}, once it went through`, async () => {
      const { adapter, fake } = makePair();
      fake.refusedWhilePending.set("htp_unknown", 52);
      const session = await openSession(adapter, { captureMethod });
      const paymentId = declinedPaymentId(await rejection(complete(adapter, session, "htp_unknown")));
      fake.settlePendingAuthorization(paymentId, "succeeded");
      const again = await complete(adapter, session, "htp_new_card");
      expect(again).toMatchObject({ status, pspPaymentId: paymentId });
      expect(fake.uniquePaymentCreations).toBe(1);
    });
  }

  it("moves on once its payment failed", async () => {
    const { adapter, fake, session, paymentId } = await refusedWhilePending();
    fake.settlePendingAuthorization(paymentId, "rejected");
    const paid = await complete(adapter, session, "htp_new_card");
    expect(paid.status).toBe("succeeded");
    expect(fake.uniquePaymentCreations).toBe(2);
    expect(fake.paymentIdUnder(await keyAfter(paymentId))).toBe(paid.pspPaymentId);
  });

  it("never moves on from a refusal whose payment was authorised when answered, whatever it reads now", async () => {
    const fake = new FakeWorldlineApi();
    const wire = interceptingFetch(fake);
    const adapter = makeAdapter(wire.fetchImpl);
    const other = await adapter.createPaymentSession({ amount: 2500, currency: "EUR", captureMethod: "manual", idempotencyKey: "session-2" });
    const authorised = await adapter.completePayment({ pspSessionId: other.pspSessionId, clientToken: "htp_card", idempotencyKey: "complete-other" });
    await adapter.cancelPayment(authorised.pspPaymentId, "cancel-other");
    // A replayed 402 reporting that payment authorised: no page shows one, and the contract does not rule it out.
    const body = {
      errorId: "err_authorised",
      errors: [{ errorCode: "GENERIC_DECLINE", httpStatusCode: 402 }],
      paymentResult: {
        payment: { id: authorised.pspPaymentId, status: "PENDING_CAPTURE", statusOutput: { statusCode: 5, statusCategory: "PENDING_MERCHANT" } },
      },
    };
    wire.answerNext(1, () =>
      new Response(JSON.stringify(body), { status: 402, headers: { "content-type": "application/json", [REPLAY_HEADER]: String(Date.now()) } }),
    );

    // Finished, as Authorised and cancelled: returned as it now reads rather than thrown as a decline.
    const again = await complete(adapter, await openSession(adapter), "htp_new_card");
    expect(again).toMatchObject({ status: "canceled", pspPaymentId: authorised.pspPaymentId });
    expect(wire.sent).toHaveLength(2);
    expect(fake.uniquePaymentCreations).toBe(1);
  });

  it("never moves on from a payment answered authorised that reads cancelled without a status code", async () => {
    const fake = new FakeWorldlineApi();
    const wire = scriptedFetch(fake);
    const adapter = makeAdapter(wire.fetchImpl);
    const session = await openSession(adapter, { captureMethod: "manual" });
    const authorised = await complete(adapter, session, "htp_card");
    // The contract does not require the status string or the code; this one reads cancelled by its string alone.
    wire.readBackAs(authorised.pspPaymentId, { status: "CANCELLED", statusOutput: { statusCategory: "UNSUCCESSFUL" } });
    const again = await complete(adapter, session, "htp_new_card");
    expect(again).toMatchObject({ status: "canceled", pspPaymentId: authorised.pspPaymentId });
    expect(fake.uniquePaymentCreations).toBe(1);
  });
});

describe("a payment authorised and cancelled since", () => {
  it("returns a manual-capture challenge authorised and then cancelled as it now reads, sending no new attempt", async () => {
    const { adapter, fake } = makePair();
    const session = await openSession(adapter, { captureMethod: "manual" });
    const challenge = await complete(adapter, session, "htp_3ds");
    fake.settleChallenge(challenge.pspPaymentId, "succeeded");
    await expect(adapter.cancelPayment(challenge.pspPaymentId, "cancel-order-42")).resolves.toMatchObject({ status: "canceled" });

    const again = await complete(adapter, session, "htp_new_card");
    expect(again).toMatchObject({ status: "canceled", pspPaymentId: challenge.pspPaymentId });
    expect((again.raw as WorldlinePaymentLike).statusOutput?.statusCode).toBe(6);
    expect(fake.uniquePaymentCreations).toBe(1);
    expect(sends(fake).map(([, replayed]) => replayed)).toEqual([false, true]);
  });

  it("returns a sale left authorised at 51 and then cancelled as it now reads, sending no new attempt", async () => {
    const { adapter, fake } = makePair();
    fake.pendingCards.set("htp_pending", 51);
    const session = await openSession(adapter);
    const pending = await complete(adapter, session, "htp_pending");
    fake.settlePendingAuthorization(pending.pspPaymentId, "succeeded");
    // The Statuses reference sends 51 on to 2 or 5 only, a sale included.
    await expect(adapter.retrievePayment(pending.pspPaymentId)).resolves.toMatchObject({ status: "requires_capture" });
    await adapter.cancelPayment(pending.pspPaymentId, "cancel-order-42");

    const again = await complete(adapter, session, "htp_new_card");
    expect(again).toMatchObject({ status: "canceled", pspPaymentId: pending.pspPaymentId });
    expect(fake.uniquePaymentCreations).toBe(1);
  });

  it("returns a refusal's payment, authorised since and then cancelled, as it now reads", async () => {
    const { adapter, fake } = makePair();
    fake.refusedWhilePending.set("htp_unknown", 52);
    const session = await openSession(adapter, { captureMethod: "manual" });
    const paymentId = declinedPaymentId(await rejection(complete(adapter, session, "htp_unknown")));
    fake.settlePendingAuthorization(paymentId, "succeeded");
    await adapter.cancelPayment(paymentId, "cancel-order-42");

    const again = await complete(adapter, session, "htp_new_card");
    expect(again).toMatchObject({ status: "canceled", pspPaymentId: paymentId });
    expect(fake.uniquePaymentCreations).toBe(1);
  });

  const answers: Array<[string, (fake: FakeWorldlineApi) => void, (fake: FakeWorldlineApi, paymentId: string) => void]> = [
    ["an authorisation", () => {}, () => {}],
    [
      "a refusal whose payment was pending",
      (fake) => fake.refusedWhilePending.set("htp_card", 52),
      (fake, paymentId) => fake.settlePendingAuthorization(paymentId, "succeeded"),
    ],
  ];
  for (const [label, arrange, authorise] of answers) {
    it(`never walks past a replayed answer to ${label} that shows its payment Authorised and cancelled`, async () => {
      const fake = new FakeWorldlineApi();
      arrange(fake);
      const wire = scriptedFetch(fake);
      const adapter = makeAdapter(wire.fetchImpl);
      const session = await openSession(adapter, { captureMethod: "manual" });
      const first = await complete(adapter, session, "htp_card").then(
        (info) => info.pspPaymentId,
        (err: unknown) => declinedPaymentId(err as PayFanoutError),
      );
      authorise(fake, first);
      await adapter.cancelPayment(first, "cancel-order-42");
      // A replay showing the payment's current status rather than its status when created.
      wire.script(showingPayment(AUTHORISED_AND_CANCELLED));

      const again = await complete(adapter, session, "htp_new_card");
      expect(again).toMatchObject({ status: "canceled", pspPaymentId: first });
      expect(fake.uniquePaymentCreations).toBe(1);
    });
  }

  it("lets the customer pay under a new idempotency key once the authorisation was cancelled", async () => {
    const { adapter, fake } = makePair();
    const session = await openSession(adapter, { captureMethod: "manual" });
    const authorised = await complete(adapter, session, "htp_card");
    await adapter.cancelPayment(authorised.pspPaymentId, "cancel-order-42");
    await expect(complete(adapter, session, "htp_new_card")).resolves.toMatchObject({ status: "canceled" });

    const paid = await adapter.completePayment({ pspSessionId: session, clientToken: "htp_new_card", idempotencyKey: `${HOST_KEY}-2` });
    expect(paid).toMatchObject({ status: "requires_capture" });
    expect(paid.pspPaymentId).not.toBe(authorised.pspPaymentId);
    expect(fake.uniquePaymentCreations).toBe(2);
  });
});

describe("an answer that is the call's own", () => {
  it("throws a decline whose first answer was lost marked outcomeUnknown, and only the next completion moves on", async () => {
    const { adapter, fake } = makePair();
    fake.declinedCards.add("htp_declined");
    fake.lostCreatePaymentAnswers = 1;
    const session = await openSession(adapter);
    const declined = await rejection(complete(adapter, session, "htp_declined"));
    // The re-send's replay may equally be an earlier completion's, whose later key could hold a payment.
    expect(declined).toMatchObject({ code: "card_declined", retryable: false, outcomeUnknown: true });
    expect(fake.uniquePaymentCreations).toBe(1);
    const linkZero = await keyAfter();
    expect(sends(fake)).toEqual([
      [linkZero, false],
      [linkZero, true],
    ]);

    const paid = await complete(adapter, session, "htp_new_card");
    expect(paid.status).toBe("succeeded");
    expect(fake.uniquePaymentCreations).toBe(2);
    expect(sends(fake).slice(2)).toEqual([
      [linkZero, true],
      [await keyAfter(declinedPaymentId(declined)), false],
    ]);
  });

  it("throws a REJECTED payment whose first answer was lost marked outcomeUnknown", async () => {
    const { adapter, fake } = makePair();
    fake.rejectPayment = { errors: [{ errorCode: "30511001", httpStatusCode: 402 }] };
    fake.lostCreatePaymentAnswers = 1;
    const session = await openSession(adapter);
    const rejected = await rejection(complete(adapter, session, "htp_card"));
    expect(rejected).toMatchObject({ code: "insufficient_funds", retryable: false, outcomeUnknown: true });
    expect(sends(fake).map(([, replayed]) => replayed)).toEqual([false, true]);
  });

  it("throws a decline as final when the re-send that met it carries no replay header", async () => {
    const { adapter, fake } = makePair();
    fake.declinedCards.add("htp_declined");
    fake.refusedCreatePaymentConnections = 1;
    const session = await openSession(adapter);
    const declined = await rejection(complete(adapter, session, "htp_declined"));
    expect(declined).toMatchObject({ code: "card_declined", retryable: false });
    expect(declined.outcomeUnknown).toBeUndefined();
    expect(sends(fake)).toEqual([[await keyAfter(), false]]);
  });

  it("returns a success whose first answer was lost, without a second payment", async () => {
    const { adapter, fake } = makePair();
    fake.lostCreatePaymentAnswers = 1;
    const session = await openSession(adapter);
    const paid = await complete(adapter, session, "htp_card");
    expect(paid.status).toBe("succeeded");
    expect(fake.uniquePaymentCreations).toBe(1);
    expect(sends(fake).map(([, replayed]) => replayed)).toEqual([false, true]);
  });

  it("reads an empty replay header as no replay", async () => {
    const fake = new FakeWorldlineApi();
    fake.declinedCards.add("htp_declined");
    const adapter = makeAdapter(rewritingReplayHeader(fake, "  "));
    const session = await openSession(adapter);
    await rejection(complete(adapter, session, "htp_declined"));
    const again = await rejection(complete(adapter, session, "htp_new_card"));
    expect(again).toMatchObject({ code: "card_declined", retryable: false });
    expect(again.outcomeUnknown).toBeUndefined();
    expect(fake.uniquePaymentCreations).toBe(1);
    expect(sends(fake).map(([, replayed]) => replayed)).toEqual([false, true]);
  });

  it("reads the replay header whatever the case of its name", async () => {
    const fake = new FakeWorldlineApi();
    fake.declinedCards.add("htp_declined");
    const adapter = makeAdapter(rewritingReplayHeader(fake, String(Date.now()), REPLAY_HEADER.toLowerCase()));
    const session = await openSession(adapter);
    await rejection(complete(adapter, session, "htp_declined"));
    await expect(complete(adapter, session, "htp_new_card")).resolves.toMatchObject({ status: "succeeded" });
    expect(fake.uniquePaymentCreations).toBe(2);
  });

  const transient: Array<[number, UnifiedErrorCode]> = [
    [409, "processing_error"],
    [429, "rate_limited"],
    [503, "psp_unavailable"],
  ];
  for (const [status, code] of transient) {
    it(`never walks past a ${status}, even one carrying the replay header and a failed payment`, async () => {
      const fake = new FakeWorldlineApi();
      fake.declinedCards.add("htp_declined");
      const wire = interceptingFetch(fake);
      const adapter = makeAdapter(wire.fetchImpl);
      const session = await openSession(adapter);
      await rejection(complete(adapter, session, "htp_declined"));
      wire.answerNext(Number.POSITIVE_INFINITY, () => transientAnswer(status));

      const error = await rejection(complete(adapter, session, "htp_new_card"));
      expect(error).toMatchObject({ code, retryable: true });
      const linkZero = await keyAfter();
      // The first completion, then the first send and both transport retries of the second.
      expect(wire.sent).toEqual([linkZero, linkZero, linkZero, linkZero]);
      expect(fake.uniquePaymentCreations).toBe(1);
    });

    it(`takes the replayed decline that follows a ${status} as the call's own, marked outcomeUnknown`, async () => {
      const fake = new FakeWorldlineApi();
      fake.declinedCards.add("htp_declined");
      const wire = interceptingFetch(fake);
      const adapter = makeAdapter(wire.fetchImpl);
      const session = await openSession(adapter);
      await rejection(complete(adapter, session, "htp_declined"));
      wire.answerNext(1, () => transientAnswer(status));

      const error = await rejection(complete(adapter, session, "htp_new_card"));
      expect(error).toMatchObject({ code: "card_declined", retryable: false, outcomeUnknown: true });
      const linkZero = await keyAfter();
      expect(wire.sent).toEqual([linkZero, linkZero, linkZero]);
      expect(fake.uniquePaymentCreations).toBe(1);
    });
  }
});

describe("a re-send that meets an earlier completion's attempt", () => {
  /**
   * A decline, or with `failure: "invalid"` a 400 that creates no payment,
   * then a success under the next key, both `elapsedMs` before the clock reads
   * `now`, where it is left for the next completion.
   */
  async function paidAfterDecline(elapsedMs: number, failure: "declined" | "invalid" = "declined") {
    const fake = new FakeWorldlineApi();
    fake.declinedCards.add("htp_declined");
    fake.invalidTokens.add("htp_invalid");
    const now = Date.now();
    let clock = now - elapsedMs;
    fake.clock = clock;
    const firstRequestAt = fake.clock;
    const adapter = makeAdapter(fake.fetch, { now: () => clock, sessionTtlSeconds: 2 * 60 * 60 });
    const session = await openSession(adapter);
    const failed = await rejection(complete(adapter, session, `htp_${failure}`));
    const paid = await complete(adapter, session, "htp_new_card");
    clock = now;
    const [linkZero, linkOne] = await Promise.all([
      keyAfter(),
      keyAfter(failure === "declined" ? declinedPaymentId(failed) : String(firstRequestAt)),
    ]);
    return { fake, adapter, session, paid, linkZero, linkOne };
  }

  it("returns the success a later key holds when the first send is refused and the re-send meets a decline made before", async () => {
    const { fake, adapter, session, paid, linkZero, linkOne } = await paidAfterDecline(30 * MINUTE);
    fake.refusedCreatePaymentConnections = 1;
    const again = await complete(adapter, session, "htp_third_card");
    expect(again).toMatchObject({ status: "succeeded", pspPaymentId: paid.pspPaymentId });
    expect(fake.uniquePaymentCreations).toBe(2);
    expect(sends(fake).slice(3)).toEqual([
      [linkZero, true],
      [linkOne, true],
    ]);
  });

  it("reads a replay more than 15 minutes older than the first send as an earlier completion's", async () => {
    const { fake, adapter, session, paid } = await paidAfterDecline(15 * MINUTE + 1);
    fake.refusedCreatePaymentConnections = 1;
    await expect(complete(adapter, session, "htp_third_card")).resolves.toMatchObject({ pspPaymentId: paid.pspPaymentId });
  });

  it("takes a replay 15 minutes old as possibly the call's own, throwing its decline marked outcomeUnknown", async () => {
    const { fake, adapter, session, paid, linkZero } = await paidAfterDecline(15 * MINUTE);
    fake.refusedCreatePaymentConnections = 1;
    const error = await rejection(complete(adapter, session, "htp_third_card"));
    expect(error).toMatchObject({ code: "card_declined", retryable: false, outcomeUnknown: true });
    expect(sends(fake).slice(3)).toEqual([[linkZero, true]]);

    // Under the same key, the next completion finds the success.
    const again = await complete(adapter, session, "htp_third_card");
    expect(again).toMatchObject({ status: "succeeded", pspPaymentId: paid.pspPaymentId });
    expect(fake.uniquePaymentCreations).toBe(2);
  });

  it("does not read a re-send's replay header that is not the documented milliseconds as an earlier attempt", async () => {
    const fake = new FakeWorldlineApi();
    fake.declinedCards.add("htp_declined");
    const adapter = makeAdapter(rewritingReplayHeader(fake, "2026-09-25T10:00:00Z"));
    const session = await openSession(adapter);
    await rejection(complete(adapter, session, "htp_declined"));
    fake.refusedCreatePaymentConnections = 1;
    const error = await rejection(complete(adapter, session, "htp_new_card"));
    expect(error).toMatchObject({ code: "card_declined", retryable: false, outcomeUnknown: true });
    expect(fake.uniquePaymentCreations).toBe(1);
  });

  it("throws a refusal that created no payment marked outcomeUnknown when a re-send meets it within 15 minutes", async () => {
    // An earlier completion's 400, then a success on the second attempt, 5 minutes ago.
    const { fake, adapter, session, paid, linkZero } = await paidAfterDecline(5 * MINUTE, "invalid");
    // This call's first send never reaches Worldline.
    fake.refusedCreatePaymentConnections = 1;
    const error = await rejection(complete(adapter, session, "htp_third_card"));
    expect(error).toMatchObject({ code: "invalid_request", retryable: false, outcomeUnknown: true });
    expect(error.raw).not.toHaveProperty("paymentResult");
    expect(sends(fake).slice(3)).toEqual([[linkZero, true]]);
    expect(fake.uniquePaymentCreations).toBe(1);

    await expect(complete(adapter, session, "htp_third_card")).resolves.toMatchObject({ pspPaymentId: paid.pspPaymentId });
    expect(fake.uniquePaymentCreations).toBe(1);
  });

  const NOW = Date.UTC(2026, 8, 25, 12);
  const implausible: Array<[string, string]> = [
    ["in seconds", String(Math.floor(NOW / 1000))],
    ["23 hours old", String(NOW - 23 * HOUR)],
  ];
  for (const [label, header] of implausible) {
    it(`takes a re-send's replay timestamp ${label} as possibly the call's own, past the first key too`, async () => {
      const fake = new FakeWorldlineApi();
      fake.declinedCards.add("htp_declined_1");
      fake.declinedCards.add("htp_declined_2");
      fake.clock = NOW;
      const wire = scriptedFetch(fake);
      const adapter = makeAdapter(wire.fetchImpl, { now: () => NOW });
      const session = await openSession(adapter);
      const first = await rejection(complete(adapter, session, "htp_declined_1"));
      // The first key's replay; the next key's first send, processed but unanswered; its re-send.
      wire.script(relay, loseAnswer, withReplayHeader(header));

      const error = await rejection(complete(adapter, session, "htp_declined_2"));
      expect(error).toMatchObject({ code: "card_declined", retryable: false, outcomeUnknown: true });
      const [linkZero, linkOne] = await Promise.all([keyAfter(), keyAfter(declinedPaymentId(first))]);
      // Nothing goes out under a third key with the card the second key declined.
      expect(sends(fake)).toEqual([
        [linkZero, false],
        [linkZero, true],
        [linkOne, false],
        [linkOne, true],
      ]);
      expect(fake.uniquePaymentCreations).toBe(2);
    });
  }

  describe("that may be the call's own", () => {
    /** A completion under the key, then `settle`, then a completion whose first send never reaches Worldline. */
    async function resentAfter(card: string, settle: (fake: FakeWorldlineApi, paymentId: string) => void = () => {}) {
      const { adapter, fake } = makePair();
      fake.pendingCards.set("htp_pending", 51);
      fake.refusedWhilePending.set("htp_unknown", 52);
      const session = await openSession(adapter);
      const first = await complete(adapter, session, card).then(
        (info) => info.pspPaymentId,
        (err: unknown) => declinedPaymentId(err as PayFanoutError),
      );
      settle(fake, first);
      fake.refusedCreatePaymentConnections = 1;
      return { adapter, fake, session, first };
    }

    it("reads a replayed challenge back, returning it as it now reads once it went through", async () => {
      const { adapter, fake, session, first } = await resentAfter("htp_3ds", (f, id) => f.settleChallenge(id, "succeeded"));
      const again = await complete(adapter, session, "htp_new_card");
      expect(again).toMatchObject({ status: "succeeded", pspPaymentId: first });
      expect(redirectUrl(again)).toBeUndefined();
      expect(fake.uniquePaymentCreations).toBe(1);
    });

    it("returns a replayed challenge still open as requires_action, with its redirect", async () => {
      const { adapter, fake, session, first } = await resentAfter("htp_3ds");
      const again = await complete(adapter, session, "htp_new_card");
      expect(again).toMatchObject({ status: "requires_action", pspPaymentId: first });
      expect(redirectUrl(again)).toContain(first);
      expect(fake.uniquePaymentCreations).toBe(1);
    });

    it("throws a replayed challenge that failed since marked outcomeUnknown, and the next completion moves on", async () => {
      const { adapter, fake, session, first } = await resentAfter("htp_3ds", (f, id) => f.settleChallenge(id, "rejected"));
      const error = await rejection(complete(adapter, session, "htp_new_card"));
      expect(error).toMatchObject({ code: "authentication_required", retryable: false, outcomeUnknown: true });
      expect(error.raw).toMatchObject({ payment: { id: first, status: "REJECTED" } });
      expect(fake.uniquePaymentCreations).toBe(1);

      const paid = await complete(adapter, session, "htp_new_card");
      expect(paid.status).toBe("succeeded");
      expect(fake.paymentIdUnder(await keyAfter(first))).toBe(paid.pspPaymentId);
    });

    it("throws a replayed pending payment that failed since marked outcomeUnknown", async () => {
      const { adapter, fake, session, first } = await resentAfter("htp_pending", (f, id) => f.settlePendingAuthorization(id, "rejected"));
      const error = await rejection(complete(adapter, session, "htp_new_card"));
      expect(error).toMatchObject({ code: "card_declined", retryable: false, outcomeUnknown: true });
      expect(error.raw).toMatchObject({ payment: { id: first, status: "REJECTED" } });
      expect(fake.uniquePaymentCreations).toBe(1);
    });

    it("returns a replayed refusal's payment that went through since", async () => {
      const { adapter, fake, session, first } = await resentAfter("htp_unknown", (f, id) => f.settlePendingAuthorization(id, "succeeded"));
      const again = await complete(adapter, session, "htp_new_card");
      expect(again).toMatchObject({ status: "succeeded", pspPaymentId: first });
      expect(fake.uniquePaymentCreations).toBe(1);
    });

    it("throws a replayed refusal whose payment failed since marked outcomeUnknown", async () => {
      const { adapter, fake, session } = await resentAfter("htp_unknown", (f, id) => f.settlePendingAuthorization(id, "rejected"));
      const error = await rejection(complete(adapter, session, "htp_new_card"));
      expect(error).toMatchObject({ code: "card_declined", retryable: false, outcomeUnknown: true });
      expect(fake.uniquePaymentCreations).toBe(1);
    });
  });
});

describe("an answer that cannot be read as a payment", () => {
  function answeringCreatePayment(fake: FakeWorldlineApi, answer: () => Response): typeof fetch {
    return async (input, init) =>
      init?.method === "POST" && String(input).endsWith("/payments") ? answer() : fake.fetch(input, init);
  }

  const bodies: Array<[string, string, unknown]> = [
    ["a JSON body without a payment", JSON.stringify({ creationOutput: {} }), { creationOutput: {} }],
    ["a body that is not JSON", "<html>OK</html>", "<html>OK</html>"],
    ["an empty body", "", ""],
  ];
  for (const [label, text, raw] of bodies) {
    it(`throws a non-retryable processing_error marked outcomeUnknown for a 2xx with ${label}, keeping the body on raw`, async () => {
      const fake = new FakeWorldlineApi();
      const adapter = makeAdapter(answeringCreatePayment(fake, () => new Response(text, { status: 201 })));
      const error = await rejection(complete(adapter, await openSession(adapter), "htp_card"));
      // A 201 means a payment object was created, and this answer does not say which.
      expect(error).toMatchObject({ code: "processing_error", retryable: false, outcomeUnknown: true, pspName: "worldline", raw });
    });
  }

  it("keeps a proxy's 502 page a retryable psp_unavailable, with the text on raw", async () => {
    const fake = new FakeWorldlineApi();
    const page = () => new Response("<html>502 Bad Gateway</html>", { status: 502 });
    const adapter = makeAdapter(answeringCreatePayment(fake, page));
    const error = await rejection(complete(adapter, await openSession(adapter), "htp_card"));
    expect(error).toMatchObject({ code: "psp_unavailable", retryable: true, raw: "<html>502 Bad Gateway</html>" });
    expect(fake.uniquePaymentCreations).toBe(0);
  });

  it("maps a refusal whose body is not JSON as before, with the text on raw", async () => {
    const fake = new FakeWorldlineApi();
    const adapter = makeAdapter(answeringCreatePayment(fake, () => new Response("Bad Request", { status: 400 })));
    const error = await rejection(complete(adapter, await openSession(adapter), "htp_card"));
    expect(error).toMatchObject({ code: "invalid_request", retryable: false, raw: "Bad Request" });
    expect(error.outcomeUnknown).toBeUndefined();
  });
});

describe("a payment that cannot be read back", () => {
  function expectUnreadable(error: PayFanoutError): void {
    // A 404 on its own reads as a final invalid_request; the payment exists, so its outcome is open.
    expect(error).toMatchObject({ code: "invalid_request", retryable: false, outcomeUnknown: true, pspName: "worldline" });
    expect(error.raw).toMatchObject({ errors: [{ id: "UNKNOWN_PAYMENT_ID", httpStatusCode: 404 }] });
  }

  it("throws the read-back of the call's own payment marked outcomeUnknown, and the next completion returns it", async () => {
    const { adapter, fake } = makePair();
    const session = await openSession(adapter);
    fake.paymentReadFailure = 404;
    expectUnreadable(await rejection(complete(adapter, session, "htp_card")));
    expect(fake.uniquePaymentCreations).toBe(1);

    fake.paymentReadFailure = undefined;
    const again = await complete(adapter, session, "htp_other_card");
    expect(again).toMatchObject({ status: "succeeded", pspPaymentId: fake.paymentIdUnder(await keyAfter()) });
    expect(fake.uniquePaymentCreations).toBe(1);
  });

  it("throws the read-back of a replayed challenge marked outcomeUnknown, sending no new attempt", async () => {
    const { adapter, fake } = makePair();
    const session = await openSession(adapter);
    await complete(adapter, session, "htp_3ds");
    fake.paymentReadFailure = 404;
    expectUnreadable(await rejection(complete(adapter, session, "htp_new_card")));
    expect(fake.uniquePaymentCreations).toBe(1);
    expect(sends(fake).map(([, replayed]) => replayed)).toEqual([false, true]);
  });

  it("throws the read-back of a payment a re-send met marked outcomeUnknown", async () => {
    const { adapter, fake } = makePair();
    const session = await openSession(adapter);
    await complete(adapter, session, "htp_card");
    fake.refusedCreatePaymentConnections = 1;
    fake.paymentReadFailure = 404;
    expectUnreadable(await rejection(complete(adapter, session, "htp_new_card")));
    expect(fake.uniquePaymentCreations).toBe(1);
  });

  it("throws the read-back of a replayed refusal's payment marked outcomeUnknown, sending no new attempt", async () => {
    const { adapter, fake } = makePair();
    fake.refusedWhilePending.set("htp_unknown", 52);
    const session = await openSession(adapter);
    const paymentId = declinedPaymentId(await rejection(complete(adapter, session, "htp_unknown")));
    fake.settlePendingAuthorization(paymentId, "succeeded");
    fake.paymentReadFailure = 404;
    expectUnreadable(await rejection(complete(adapter, session, "htp_new_card")));
    expect(fake.uniquePaymentCreations).toBe(1);
    expect(sends(fake).map(([, replayed]) => replayed)).toEqual([false, true]);
  });

  it("keeps a read-back that fails transiently a retryable psp_unavailable", async () => {
    const { adapter, fake } = makePair();
    const session = await openSession(adapter);
    fake.paymentReadFailure = 503;
    const error = await rejection(complete(adapter, session, "htp_card"));
    expect(error).toMatchObject({ code: "psp_unavailable", retryable: true });
    expect(error.outcomeUnknown).toBeUndefined();
    expect(fake.uniquePaymentCreations).toBe(1);
  });
});

describe("a key whose earlier payment was made for another amount or currency", () => {
  /** A 2500 EUR session declined, then paid on its second attempt, under the host key. */
  async function paidAfterDecline() {
    const { adapter, fake } = makePair();
    fake.declinedCards.add("htp_declined");
    const first = await openSession(adapter);
    await rejection(complete(adapter, first, "htp_declined"));
    const paid = await complete(adapter, first, "htp_new_card");
    return { adapter, fake, paid };
  }

  function expectAnotherSessions(error: PayFanoutError, paymentId: string, amount: number, currency: string): void {
    expect(error).toMatchObject({
      code: "invalid_request",
      retryable: false,
      outcomeUnknown: true,
      pspName: "worldline",
      message: getUserMessage("invalid_request"),
    });
    expect(error.raw).toMatchObject({
      reason: "another_sessions_payment",
      payment: { id: paymentId },
      sessionAmount: amount,
      sessionCurrency: currency,
    });
  }

  const others: Array<[number, string]> = [
    [3000, "USD"],
    [3000, "EUR"],
    [2500, "USD"],
  ];
  for (const [amount, currency] of others) {
    it(`refuses a ${amount} ${currency} session under the same key, creating no payment`, async () => {
      const { adapter, fake, paid } = await paidAfterDecline();
      const other = await openSession(adapter, { amount, currency, idempotencyKey: "session-2" });
      expectAnotherSessions(await rejection(complete(adapter, other, "htp_third_card")), paid.pspPaymentId, amount, currency);
      expect(fake.uniquePaymentCreations).toBe(2);
    });
  }

  it("refuses another session's payment answered without the replay header, as if it were the call's own", async () => {
    const fake = new FakeWorldlineApi();
    const adapter = makeAdapter(rewritingReplayHeader(fake, String(Date.now()), "X-Unrelated-Header"));
    const paid = await complete(adapter, await openSession(adapter), "htp_card");
    const other = await openSession(adapter, { amount: 3000, idempotencyKey: "session-2" });
    expectAnotherSessions(await rejection(complete(adapter, other, "htp_new_card")), paid.pspPaymentId, 3000, "EUR");
    expect(fake.uniquePaymentCreations).toBe(1);
  });

  it("does not count a payment read back with a lower-case currency code as another session's", async () => {
    const fake = new FakeWorldlineApi();
    const wire = scriptedFetch(fake);
    const adapter = makeAdapter(wire.fetchImpl);
    const session = await openSession(adapter);
    const paid = await complete(adapter, session, "htp_card");
    wire.readBackAs(paid.pspPaymentId, { paymentOutput: { amountOfMoney: { amount: 2500, currencyCode: "eur" } } });
    await expect(complete(adapter, session, "htp_new_card")).resolves.toMatchObject({ pspPaymentId: paid.pspPaymentId });
    expect(fake.uniquePaymentCreations).toBe(1);
  });

  it("returns another session's payment, authorised and cancelled since, as it now reads", async () => {
    const { adapter, fake } = makePair();
    const authorised = await complete(adapter, await openSession(adapter, { captureMethod: "manual" }), "htp_card");
    await adapter.cancelPayment(authorised.pspPaymentId, "cancel-order-42");
    const other = await openSession(adapter, { amount: 3000, idempotencyKey: "session-2" });
    await expect(complete(adapter, other, "htp_new_card")).resolves.toMatchObject({
      status: "canceled",
      pspPaymentId: authorised.pspPaymentId,
    });
    expect(fake.uniquePaymentCreations).toBe(1);
  });

  it("returns the payment to another session for the same amount and currency", async () => {
    const { adapter, fake, paid } = await paidAfterDecline();
    const other = await openSession(adapter, { idempotencyKey: "session-2" });
    await expect(complete(adapter, other, "htp_third_card")).resolves.toMatchObject({ pspPaymentId: paid.pspPaymentId });
    expect(fake.uniquePaymentCreations).toBe(2);
  });

  const omitted: Array<[string, Partial<WorldlinePaymentLike>]> = [
    ["its payment output", { paymentOutput: undefined }],
    ["its amount of money", { paymentOutput: {} }],
    ["the amount and the currency", { paymentOutput: { amountOfMoney: {} } }],
  ];
  for (const [label, fields] of omitted) {
    it(`does not count a payment read back without ${label} as another session's`, async () => {
      const fake = new FakeWorldlineApi();
      const wire = scriptedFetch(fake);
      const adapter = makeAdapter(wire.fetchImpl);
      const session = await openSession(adapter);
      const paid = await complete(adapter, session, "htp_card");
      wire.readBackAs(paid.pspPaymentId, fields);
      await expect(complete(adapter, session, "htp_new_card")).resolves.toMatchObject({
        status: "succeeded",
        pspPaymentId: paid.pspPaymentId,
      });
      expect(fake.uniquePaymentCreations).toBe(1);
    });
  }

  it("refuses the same integer amount in a currency with another exponent", async () => {
    const { adapter, fake } = makePair();
    const paid = await complete(adapter, await openSession(adapter, { amount: 500, currency: "JPY" }), "htp_card");
    const other = await openSession(adapter, { amount: 500, currency: "BHD", idempotencyKey: "session-2" });
    expectAnotherSessions(await rejection(complete(adapter, other, "htp_new_card")), paid.pspPaymentId, 500, "BHD");
    expect(fake.uniquePaymentCreations).toBe(1);
  });

  it("still walks past another session's attempt that failed, and pays this session's amount", async () => {
    const { adapter, fake } = makePair();
    fake.declinedCards.add("htp_declined");
    await rejection(complete(adapter, await openSession(adapter), "htp_declined"));
    const other = await openSession(adapter, { amount: 3000, currency: "USD", idempotencyKey: "session-2" });
    await expect(complete(adapter, other, "htp_new_card")).resolves.toMatchObject({ status: "succeeded", amount: 3000, currency: "USD" });
    expect(fake.uniquePaymentCreations).toBe(2);
  });

  for (const captureMethod of ["automatic", "manual"] as const) {
    it(`refuses it after a refusal whose pending ${captureMethod}-capture payment was captured since`, async () => {
      const { adapter, fake } = makePair();
      fake.refusedWhilePending.set("htp_unknown", 52);
      const first = await openSession(adapter, { captureMethod });
      const paymentId = declinedPaymentId(await rejection(complete(adapter, first, "htp_unknown")));
      fake.settlePendingAuthorization(paymentId, "succeeded");
      if (captureMethod === "manual") await adapter.capturePayment(paymentId, undefined, "capture-order-42");
      await expect(adapter.retrievePayment(paymentId)).resolves.toMatchObject({ status: "succeeded" });

      const other = await openSession(adapter, { amount: 3000, currency: "USD", idempotencyKey: "session-2" });
      expectAnotherSessions(await rejection(complete(adapter, other, "htp_new_card")), paymentId, 3000, "USD");
      expect(fake.uniquePaymentCreations).toBe(1);
    });
  }
});

describe("the limits of one key", () => {
  it("sends the first attempt under the key derived from the host key alone, as before", async () => {
    const { adapter, fake } = makePair();
    const session = await openSession(adapter);
    await complete(adapter, session, "htp_card");
    expect(sends(fake)).toEqual([[await deriveIdempotenceKey(HOST_KEY), false]]);
  });

  it("refuses a 21st attempt with a non-retryable invalid_request, sending nothing new", async () => {
    const { adapter, fake } = makePair();
    // A per-order key across sessions, each with its own hosted tokenization, as Worldline issues one per session.
    for (let attempt = 1; attempt <= 20; attempt++) {
      const { pspSessionId, hostedTokenizationId } = await openTokenizedSession(adapter);
      fake.declinedCards.add(hostedTokenizationId);
      await expect(complete(adapter, pspSessionId, hostedTokenizationId)).rejects.toMatchObject({ code: "card_declined" });
    }
    expect(fake.uniquePaymentCreations).toBe(20);
    const before = fake.createPaymentLog.length;

    const last = await openTokenizedSession(adapter);
    const refused = await rejection(complete(adapter, last.pspSessionId, last.hostedTokenizationId));
    expect(refused).toMatchObject({
      code: "invalid_request",
      retryable: false,
      pspName: "worldline",
      message: getUserMessage("invalid_request"),
    });
    // Every attempt under the key was read back and failed, so no payment under it can exist.
    expect(refused.outcomeUnknown).toBeUndefined();
    expect(refused.raw).toMatchObject({
      reason: "attempt_limit",
      attempts: 20,
      lastFailure: { paymentResult: { payment: { status: "REJECTED" } } },
    });
    const lastWalk = fake.createPaymentLog.slice(before);
    expect(lastWalk).toHaveLength(20);
    expect(lastWalk.every(({ replayed }) => replayed)).toBe(true);
    expect(fake.uniquePaymentCreations).toBe(20);
  });

  it("names a refusal that created no payment by its request's timestamp, so a new errorId on each replay changes nothing", async () => {
    const { adapter, fake } = makePair();
    fake.invalidTokens.add("htp_expired");
    fake.freshErrorIdOnReplay = true;
    const session = await openSession(adapter);
    const firstRequestAt = fake.clock;
    const refused = await rejection(complete(adapter, session, "htp_expired"));
    expect(refused).toMatchObject({ code: "invalid_request", retryable: false });
    expect(refused.raw).not.toHaveProperty("paymentResult");

    const paid = await complete(adapter, session, "htp_new_card");
    const again = await complete(adapter, session, "htp_third_card");
    expect(again.pspPaymentId).toBe(paid.pspPaymentId);
    expect(fake.uniquePaymentCreations).toBe(1);
    const [linkZero, linkOne] = await Promise.all([keyAfter(), keyAfter(String(firstRequestAt))]);
    expect(sends(fake)).toEqual([
      [linkZero, false],
      [linkZero, true],
      [linkOne, false],
      [linkZero, true],
      [linkOne, true],
    ]);
  });

  describe("a key whose first attempt was made the day before", () => {
    async function declinedHoursAgo(hours: number) {
      const fake = new FakeWorldlineApi();
      fake.declinedCards.add("htp_declined");
      const now = Date.now();
      fake.clock = now - hours * HOUR;
      const earlier = makeAdapter(fake.fetch, { now: () => now - hours * HOUR });
      await rejection(complete(earlier, await openSession(earlier), "htp_declined"));
      // A new session for the same order, under the same host key, expiring an hour from now.
      const adapter = makeAdapter(fake.fetch, { now: () => now });
      return { fake, adapter, session: await openSession(adapter) };
    }

    it("walks on while Worldline must still hold that attempt when the session expires", async () => {
      const { fake, adapter, session } = await declinedHoursAgo(21.5);
      await expect(complete(adapter, session, "htp_new_card")).resolves.toMatchObject({ status: "succeeded" });
      expect(fake.uniquePaymentCreations).toBe(2);
    });

    it("sends no new attempt when Worldline could forget that attempt before the session expires", async () => {
      const { fake, adapter, session } = await declinedHoursAgo(22.5);
      const refused = await rejection(complete(adapter, session, "htp_new_card"));
      expect(refused).toMatchObject({
        code: "invalid_request",
        retryable: false,
        pspName: "worldline",
        message: getUserMessage("invalid_request"),
        // It read only the first key, and a later one may hold a payment.
        outcomeUnknown: true,
      });
      expect(refused.raw).toMatchObject({
        reason: "first_attempt_may_expire",
        firstRequestAt: expect.stringMatching(/^\d+$/),
        sessionExpiresAt: expect.any(Number),
        lastFailure: { paymentResult: { payment: { status: "REJECTED" } } },
      });
      expect(fake.uniquePaymentCreations).toBe(1);
      expect(sends(fake).map(([, replayed]) => replayed)).toEqual([false, true]);
    });
  });

  describe("the replay timestamp the first attempt is dated by", () => {
    const NOW = Date.UTC(2026, 8, 25, 12);
    const SESSION_EXPIRY = NOW + HOUR;
    const cases: Array<[string, string, number, "walks" | "refuses"]> = [
      ["a first attempt Worldline must hold a millisecond past the session's expiry", String(SESSION_EXPIRY - 23 * HOUR + 1), NOW, "walks"],
      ["a first attempt Worldline could forget as the session expires", String(SESSION_EXPIRY - 23 * HOUR), NOW, "refuses"],
      ["a timestamp an hour ahead of the server's clock", String(NOW + HOUR), NOW, "walks"],
      ["a timestamp more than an hour ahead of the server's clock", String(NOW + HOUR + 1), NOW, "refuses"],
      ["a timestamp in microseconds", String(NOW * 1000), NOW, "refuses"],
      ["a timestamp in seconds", String(Math.floor(NOW / 1000)), NOW, "refuses"],
      ["a timestamp in exponent notation", "1.7e12", 1.7e12 + HOUR, "refuses"],
      ["an ISO-8601 timestamp", "2026-09-25T11:00:00Z", NOW, "refuses"],
    ];
    for (const [label, header, now, expected] of cases) {
      it(`${expected === "walks" ? "walks on after" : "sends no new attempt after"} ${label}`, async () => {
        const fake = new FakeWorldlineApi();
        fake.declinedCards.add("htp_declined");
        const adapter = makeAdapter(rewritingReplayHeader(fake, header), { now: () => now });
        const session = await openSession(adapter);
        await rejection(complete(adapter, session, "htp_declined"));
        const outcome = complete(adapter, session, "htp_new_card");
        if (expected === "walks") {
          await expect(outcome).resolves.toMatchObject({ status: "succeeded" });
          expect(fake.uniquePaymentCreations).toBe(2);
        } else {
          const refused = await rejection(outcome);
          expect(refused).toMatchObject({ code: "invalid_request", retryable: false, outcomeUnknown: true });
          expect(refused.raw).toMatchObject({ reason: "first_attempt_may_expire", firstRequestAt: header });
          expect(fake.uniquePaymentCreations).toBe(1);
        }
      });
    }
  });
});
