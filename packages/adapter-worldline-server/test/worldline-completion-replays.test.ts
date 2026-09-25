import { describe, expect, it } from "vitest";
import type { CreatePaymentSessionInput, PayFanoutError, PaymentInfo, UnifiedErrorCode } from "@payfanout/core";
import { deriveIdempotenceKey, WorldlineServerAdapter, type WorldlineServerAdapterConfig } from "../src/index.js";
import { FakeWorldlineApi } from "./fake-worldline-api.js";

const HOST_KEY = "complete-order-42";
const HOUR = 60 * 60 * 1000;
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

/** The REJECTED payment a 402 decline reports in its paymentResult. */
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
    it(`returns the payment as it now reads, ${status}, once a ${captureMethod}-capture challenge succeeded`, async () => {
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

describe("an answer that is the call's own", () => {
  it("throws a decline whose first answer was lost as that decline, and only the next completion moves on", async () => {
    const { adapter, fake } = makePair();
    fake.declinedCards.add("htp_declined");
    fake.lostCreatePaymentAnswers = 1;
    const session = await openSession(adapter);
    const declined = await rejection(complete(adapter, session, "htp_declined"));
    expect(declined).toMatchObject({ code: "card_declined", retryable: false });
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

    it(`treats the answer that follows a ${status} as the call's own, though it replays a decline`, async () => {
      const fake = new FakeWorldlineApi();
      fake.declinedCards.add("htp_declined");
      const wire = interceptingFetch(fake);
      const adapter = makeAdapter(wire.fetchImpl);
      const session = await openSession(adapter);
      await rejection(complete(adapter, session, "htp_declined"));
      wire.answerNext(1, () => transientAnswer(status));

      const error = await rejection(complete(adapter, session, "htp_new_card"));
      expect(error).toMatchObject({ code: "card_declined", retryable: false });
      const linkZero = await keyAfter();
      expect(wire.sent).toEqual([linkZero, linkZero, linkZero]);
      expect(fake.uniquePaymentCreations).toBe(1);
    });
  }
});

describe("an answer that cannot be read as a payment", () => {
  function answeringCreatePayment(fake: FakeWorldlineApi, answer: () => Response): typeof fetch {
    return async (input, init) =>
      init?.method === "POST" && String(input).endsWith("/payments") ? answer() : fake.fetch(input, init);
  }

  const bodies: Array<[string, string, unknown]> = [
    ["a JSON body without a payment", JSON.stringify({ creationOutput: {} }), { creationOutput: {} }],
    ["a body that is not JSON", "<html>OK</html>", "<html>OK</html>"],
  ];
  for (const [label, text, raw] of bodies) {
    it(`throws a non-retryable processing_error for a 2xx with ${label}, keeping the body on raw`, async () => {
      const fake = new FakeWorldlineApi();
      const adapter = makeAdapter(answeringCreatePayment(fake, () => new Response(text, { status: 201 })));
      const error = await rejection(complete(adapter, await openSession(adapter), "htp_card"));
      expect(error).toMatchObject({ code: "processing_error", retryable: false, pspName: "worldline", raw });
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
  });
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
    fake.declinedCards.add("htp_declined");
    const session = await openSession(adapter);
    for (let attempt = 1; attempt <= 20; attempt++) {
      await expect(complete(adapter, session, "htp_declined")).rejects.toMatchObject({ code: "card_declined" });
    }
    expect(fake.uniquePaymentCreations).toBe(20);
    const before = fake.createPaymentLog.length;

    const refused = await rejection(complete(adapter, session, "htp_new_card"));
    expect(refused).toMatchObject({ code: "invalid_request", retryable: false, pspName: "worldline" });
    expect(refused.message).toMatch(/new idempotency key/);
    expect(refused.raw).toMatchObject({ attempts: 20, lastFailure: { paymentResult: { payment: { status: "REJECTED" } } } });
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
    async function declinedHoursAgo(hours: number, fetchFor: (fake: FakeWorldlineApi) => typeof fetch = (fake) => fake.fetch) {
      const fake = new FakeWorldlineApi();
      fake.declinedCards.add("htp_declined");
      const now = Date.now();
      fake.clock = now - hours * HOUR;
      const earlier = makeAdapter(fetchFor(fake), { now: () => now - hours * HOUR });
      await rejection(complete(earlier, await openSession(earlier), "htp_declined"));
      // A new session for the same order, under the same host key, expiring an hour from now.
      const adapter = makeAdapter(fetchFor(fake), { now: () => now });
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
      expect(refused).toMatchObject({ code: "invalid_request", retryable: false, pspName: "worldline" });
      expect(refused.message).toMatch(/new idempotency key/);
      expect(refused.raw).toMatchObject({ firstRequestAt: expect.stringMatching(/^\d+$/), sessionExpiresAt: expect.any(Number) });
      expect(fake.uniquePaymentCreations).toBe(1);
      expect(sends(fake).map(([, replayed]) => replayed)).toEqual([false, true]);
    });

    it("sends no new attempt when the replay header is not the documented milliseconds", async () => {
      const { fake, adapter, session } = await declinedHoursAgo(1, (fake) => rewritingReplayHeader(fake, "2026-09-25T10:00:00Z"));
      const refused = await rejection(complete(adapter, session, "htp_new_card"));
      expect(refused).toMatchObject({ code: "invalid_request", retryable: false });
      expect(fake.uniquePaymentCreations).toBe(1);
    });
  });
});
