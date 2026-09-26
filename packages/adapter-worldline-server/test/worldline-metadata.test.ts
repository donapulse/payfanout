import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { isPayFanoutError, type CreatePaymentSessionInput, type PayFanoutError } from "@payfanout/core";
import {
  decodeSessionContext,
  encodeSessionContext,
  mapWorldlineError,
  parseWorldlineWebhookEvent,
  readWorldlineWebhookMetadata,
  WorldlineServerAdapter,
  type WorldlinePaymentLike,
  type WorldlineServerAdapterConfig,
} from "../src/index.js";
import { FakeWorldlineApi } from "./fake-worldline-api.js";

const SIGNING_KEY = "session-signing-key";
const WEBHOOK_KEY_ID = "wh-key-1";
const WEBHOOK_SECRET = "webhook-secret";
const RETURN_URL = "https://host.example/return";
const PAYMENTS_URL = "https://payment.preprod.direct.worldline-solutions.com/v2/mid-1/payments";
const PROPERTY_NAME = "order.references.merchantParameters";
const EPOCH = "1970-01-01T00:00:00.000Z";
const METADATA = { plan: "pro", cart: "c-1042" };

function makePair(config: Partial<WorldlineServerAdapterConfig> = {}) {
  const fake = new FakeWorldlineApi();
  const fetchSpy = vi.fn(fake.fetch);
  const adapter = new WorldlineServerAdapter({
    apiKeyId: "api-key-id",
    secretApiKey: "secret-api-key",
    merchantId: "mid-1",
    environment: "sandbox",
    sessionSigningKey: SIGNING_KEY,
    webhookKeys: [{ keyId: WEBHOOK_KEY_ID, secretKey: WEBHOOK_SECRET }],
    defaultReturnUrl: RETURN_URL,
    fetch: fetchSpy,
    ...config,
  });
  return { adapter, fake, fetchSpy };
}

async function complete(
  adapter: WorldlineServerAdapter,
  session: Partial<CreatePaymentSessionInput> = {},
  clientToken = "htp_1",
) {
  const created = await adapter.createPaymentSession({ amount: 2500, currency: "EUR", idempotencyKey: "session-1", ...session });
  const info = await adapter.completePayment({ pspSessionId: created.pspSessionId, clientToken, idempotencyKey: "complete-1" });
  return { session: created, info };
}

function refusal(adapter: WorldlineServerAdapter, metadata: unknown): Promise<PayFanoutError | undefined> {
  return adapter
    .createPaymentSession({ amount: 1000, currency: "EUR", idempotencyKey: "k", metadata: metadata as Record<string, string> })
    .then(
      () => undefined,
      (err: unknown) => {
        if (isPayFanoutError(err)) return err;
        throw err;
      },
    );
}

function sentReferences(fake: FakeWorldlineApi): Record<string, unknown> | undefined {
  return (fake.lastCreatePaymentBody as { order: { references?: Record<string, unknown> } }).order.references;
}

function signed(body: unknown): { rawBody: string; headers: Record<string, string> } {
  const rawBody = JSON.stringify(body);
  const signature = createHmac("sha256", WEBHOOK_SECRET).update(rawBody, "utf8").digest("base64");
  return { rawBody, headers: { "x-gcs-signature": signature, "x-gcs-keyid": WEBHOOK_KEY_ID } };
}

/** A captured payment carrying this paymentOutput next to its amount. */
function captured(paymentOutput: Record<string, unknown>): WorldlinePaymentLike {
  return {
    id: "pay_read",
    status: "CAPTURED",
    statusOutput: { statusCode: 9, statusCategory: "COMPLETED" },
    paymentOutput: { amountOfMoney: { amount: 2500, currencyCode: "EUR" }, ...paymentOutput },
  } as WorldlinePaymentLike;
}

/** retrievePayment of a GetPayment answering this payment, with no captures or refunds. */
function readBack(payment: WorldlinePaymentLike) {
  const { adapter } = makePair({
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      const body = path.endsWith("/captures") ? { captures: [] } : path.endsWith("/refunds") ? { refunds: [] } : payment;
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  return adapter.retrievePayment(payment.id);
}

function webhookOf(payment: WorldlinePaymentLike) {
  return parseWorldlineWebhookEvent(JSON.stringify({ id: "evt_1", type: "payment.captured", payment }));
}

/** Metadata whose JSON is `length` UTF-16 code units, its one value repeating `character`. */
function metadataOfLength(length: number, character = "x"): Record<string, string> {
  const overhead = JSON.stringify({ k: "" }).length;
  const metadata = { k: character.repeat((length - overhead) / character.length) };
  expect(JSON.stringify(metadata)).toHaveLength(length);
  return metadata;
}

interface FakeAnswer {
  status: number;
  body: {
    errors?: Array<{ propertyName?: string }>;
    payment?: { id: string };
    paymentResult?: { payment?: { id: string } };
  };
}

/** A request straight to the fake, signed as the adapter would sign it. */
async function callFake(fake: FakeWorldlineApi, method: "GET" | "POST", url: string, body?: unknown): Promise<FakeAnswer> {
  const response = await fake.fetch(url, {
    method,
    headers: {
      authorization: "GCS v1HMAC:api-key-id:signature",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as FakeAnswer["body"] };
}

/** A CreatePayment body within every documented limit, sent straight to the fake. */
function postCreatePayment(
  fake: FakeWorldlineApi,
  references: Record<string, unknown>,
  { amount = 1000, hostedTokenizationId = "htp_1", authorizationMode = "SALE" } = {},
): Promise<FakeAnswer> {
  return callFake(fake, "POST", PAYMENTS_URL, {
    order: { amountOfMoney: { amount, currencyCode: "EUR" }, references },
    hostedTokenizationId,
    cardPaymentMethodSpecificInput: {
      authorizationMode,
      returnUrl: RETURN_URL,
      threeDSecure: { skipAuthentication: false, redirectionData: { returnUrl: RETURN_URL } },
    },
  });
}

/** An adapter whose CreatePayment answers come from the fake, their paymentOutput edited on the way back. */
function editingCreateAnswers(edit: (paymentOutput: Record<string, unknown>) => void) {
  const fake = new FakeWorldlineApi();
  const { adapter } = makePair({
    fetch: async (input, init) => {
      const response = await fake.fetch(input, init);
      if (init?.method !== "POST" || !new URL(String(input)).pathname.endsWith("/payments")) return response;
      const answer = (await response.json()) as { payment: { paymentOutput: Record<string, unknown> } };
      edit(answer.payment.paymentOutput);
      return new Response(JSON.stringify(answer), { status: response.status, headers: response.headers });
    },
  });
  return { adapter, fake };
}

describe("session metadata travels as order.references.merchantParameters", () => {
  it("sends it JSON-encoded and reads it back on completion and on retrievePayment", async () => {
    const { adapter, fake } = makePair();
    const { session, info } = await complete(adapter, { id: "order-5", metadata: METADATA });
    expect(sentReferences(fake)).toEqual({ merchantReference: "order-5", merchantParameters: JSON.stringify(METADATA) });
    expect(info.metadata).toEqual(METADATA);
    expect(info.id).toBe("order-5");
    expect((await adapter.retrievePayment(info.pspPaymentId)).metadata).toEqual(METADATA);
    // The signed token is what carries it from the session to the completion.
    expect((await decodeSessionContext(session.pspSessionId, SIGNING_KEY)).metadata).toEqual(METADATA);
  });

  it("reports on a 3-D Secure challenge's answer the metadata it sent, which the answer does not echo, and reads Worldline's echo on retrievePayment", async () => {
    const { adapter } = makePair();
    const { info } = await complete(adapter, { metadata: METADATA }, "htp_3ds");
    expect(info.status).toBe("requires_action");
    expect(JSON.stringify(info.raw)).not.toContain("merchantParameters");
    expect(info.metadata).toEqual(METADATA);
    expect((await adapter.retrievePayment(info.pspPaymentId)).metadata).toEqual(METADATA);
  });

  it("reports a challenge answer's own echo whenever it carries one, and the metadata sent only when it carries none", async () => {
    const cases: Array<[string, (paymentOutput: Record<string, unknown>) => void, Record<string, string> | undefined]> = [
      ["no echo", () => {}, METADATA],
      ["an echo of null", (output) => (output["references"] = { merchantParameters: null }), METADATA],
      ["an echo of null on the deprecated field", (output) => (output["merchantParameters"] = null), METADATA],
      ["an echo", (output) => (output["references"] = { merchantParameters: JSON.stringify({ source: "echo" }) }), { source: "echo" }],
      [
        "an echo on the deprecated field only",
        (output) => (output["merchantParameters"] = JSON.stringify({ source: "deprecated" })),
        { source: "deprecated" },
      ],
      ["an echo that is not metadata", (output) => (output["references"] = { merchantParameters: "SessionID=126548354" }), undefined],
    ];
    for (const [label, edit, expected] of cases) {
      const { adapter } = editingCreateAnswers(edit);
      const { info } = await complete(adapter, { metadata: METADATA }, "htp_3ds");
      expect(info.status, label).toBe("requires_action");
      expect(info.metadata, label).toEqual(expected);
    }
  });

  it("reports an earlier session's metadata on the payment a completion under its key returns, not its own session's", async () => {
    for (const card of ["htp_1", "htp_3ds"]) {
      const { adapter, fake } = makePair();
      const first = await complete(adapter, { metadata: { order: "first" } }, card);
      // Another session completed under the same key: Worldline replays the first answer.
      const { info } = await complete(adapter, { metadata: { order: "second" } }, "htp_other");
      expect(info.pspPaymentId, card).toBe(first.info.pspPaymentId);
      expect(info.status, card).toBe(first.info.status);
      expect(info.metadata, card).toEqual({ order: "first" });
      expect(fake.uniquePaymentCreations, card).toBe(1);
    }
  });

  it("reads it back from the payment's webhook through readWorldlineWebhookMetadata", async () => {
    const { adapter, fake } = makePair();
    const { info } = await complete(adapter, { metadata: METADATA });
    const { rawBody, headers } = signed(fake.webhookBody(info.pspPaymentId, "payment.captured"));
    await expect(adapter.verifyWebhookSignature(rawBody, headers)).resolves.toBe(true);
    const event = await adapter.parseWebhookEvent(rawBody);
    expect(event).toMatchObject({ type: "payment.succeeded", pspPaymentId: info.pspPaymentId });
    expect(readWorldlineWebhookMetadata(event)).toEqual(METADATA);
  });

  it("sends no merchantParameters for a session without metadata, with an empty one or with null, and reads none back", async () => {
    for (const metadata of [undefined, {}, null]) {
      const { adapter, fake } = makePair();
      const { session, info } = await complete(adapter, { id: "order-6", metadata: metadata as Record<string, string> | undefined });
      expect(sentReferences(fake)).toEqual({ merchantReference: "order-6" });
      expect(info).not.toHaveProperty("metadata");
      expect(await decodeSessionContext(session.pspSessionId, SIGNING_KEY)).not.toHaveProperty("metadata");
      const event = await adapter.parseWebhookEvent(JSON.stringify(fake.webhookBody(info.pspPaymentId, "payment.captured")));
      expect(readWorldlineWebhookMetadata(event)).toBeUndefined();
    }
  });

  it("completes a session token signed before metadata was carried, sending none", async () => {
    const legacy = await encodeSessionContext(
      {
        v: 1,
        amount: 1000,
        currency: "EUR",
        captureMethod: "automatic",
        hostedTokenizationId: "htp_old",
        expiresAt: Date.now() + 60_000,
        returnUrl: RETURN_URL,
        id: "order-old",
      },
      SIGNING_KEY,
    );
    expect(await decodeSessionContext(legacy, SIGNING_KEY)).not.toHaveProperty("metadata");
    const { adapter, fake } = makePair();
    const info = await adapter.completePayment({ pspSessionId: legacy, clientToken: "htp_old", idempotencyKey: "complete-old" });
    expect(info.status).toBe("succeeded");
    expect(sentReferences(fake)).toEqual({ merchantReference: "order-old" });
    expect(info).not.toHaveProperty("metadata");
  });

  it("sends none for a hand-minted context whose metadata is empty or not an object, and reports none on its challenge", async () => {
    for (const metadata of [{}, "plan=pro"]) {
      for (const [clientToken, status] of [["htp_1", "succeeded"], ["htp_3ds", "requires_action"]] as const) {
        const label = `${JSON.stringify(metadata)} ${clientToken}`;
        const context = await encodeSessionContext(
          {
            v: 1,
            amount: 1000,
            currency: "EUR",
            captureMethod: "automatic",
            hostedTokenizationId: clientToken,
            expiresAt: Date.now() + 60_000,
            returnUrl: RETURN_URL,
            id: "order-minted",
            metadata: metadata as unknown as Record<string, string>,
          },
          SIGNING_KEY,
        );
        const { adapter, fake } = makePair();
        const info = await adapter.completePayment({ pspSessionId: context, clientToken, idempotencyKey: "complete-minted" });
        expect(info.status, label).toBe(status);
        expect(sentReferences(fake), label).toEqual({ merchantReference: "order-minted" });
        expect(info, label).not.toHaveProperty("metadata");
      }
    }
  });
});

describe("merchantParameters holds at most 1000 characters", () => {
  it("accepts metadata whose JSON is exactly 1000 characters and sends it whole", async () => {
    const metadata = metadataOfLength(1000);
    const { adapter, fake } = makePair();
    const { info } = await complete(adapter, { metadata });
    expect(info.status).toBe("succeeded");
    expect(sentReferences(fake)?.["merchantParameters"]).toBe(JSON.stringify(metadata));
    expect(info.metadata).toEqual(metadata);
  });

  it("refuses metadata whose JSON is 1001 characters before any call to Worldline", async () => {
    const { adapter, fetchSpy } = makePair();
    const error = await refusal(adapter, metadataOfLength(1001));
    expect(error).toMatchObject({ code: "invalid_request", retryable: false });
    expect(error?.message).toMatch(/at most 1000 characters .*, got 1001$/);
    expect(error?.raw).toEqual({ propertyName: PROPERTY_NAME, length: 1001 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("counts UTF-16 code units, so a character outside the Basic Multilingual Plane counts two", async () => {
    const astral = metadataOfLength(1000, "😀"); // 504 code points in 1000 code units
    expect((await complete(makePair().adapter, { metadata: astral })).info.metadata).toEqual(astral);

    // 505 code points, within the contract's count, but 1002 code units.
    const over = makePair();
    const error = await refusal(over.adapter, metadataOfLength(1002, "😀"));
    expect(error).toMatchObject({ code: "invalid_request", raw: { propertyName: PROPERTY_NAME, length: 1002 } });
    expect(over.fetchSpy).not.toHaveBeenCalled();

    const accented = metadataOfLength(1000, "é"); // JSON.stringify leaves it unescaped, one code unit
    expect((await complete(makePair().adapter, { metadata: accented })).info.metadata).toEqual(accented);
  });

  it("refuses metadata whose JSON is not an object of strings before any call to Worldline", async () => {
    class Tier {
      readonly plan = "pro";
      // What JSON.stringify sends, and what reads back, is this, not the string above.
      toJSON(): Record<string, unknown> {
        return { plan: 1 };
      }
    }
    const cycle: Record<string, unknown> = { plan: "pro" };
    cycle["self"] = cycle;
    const cases: Array<[string, unknown, Record<string, unknown>]> = [
      ["a number value", { plan: "pro", seats: 3 }, { key: "seats" }],
      ["a boolean value", { gift: true }, { key: "gift" }],
      ["a null value", { note: null }, { key: "note" }],
      ["a nested object", { plan: { tier: "pro" } }, { key: "plan" }],
      ["a toJSON that makes a number of a string entry", new Tier(), { key: "plan" }],
      ["a string", "plan=pro", {}],
      ["an array", ["pro"], {}],
      ["a Date, whose JSON is a string", new Date(0), {}],
      ["a BigInt value, which JSON cannot hold", { seats: 3n }, {}],
      ["a cycle, which JSON cannot hold", cycle, {}],
      ["a function, which has no JSON", () => "pro", {}],
    ];
    for (const [label, metadata, raw] of cases) {
      const { adapter, fetchSpy } = makePair();
      const error = await refusal(adapter, metadata);
      expect(error, label).toMatchObject({ code: "invalid_request", retryable: false });
      expect(error?.raw, label).toEqual({ propertyName: PROPERTY_NAME, ...raw });
      expect(fetchSpy, label).not.toHaveBeenCalled();
    }
  });

  it("checks the JSON that is sent, so an entry JSON leaves out is not sent and reads back absent", async () => {
    const { adapter, fake } = makePair();
    const { session, info } = await complete(adapter, { metadata: { plan: "pro", coupon: undefined } as unknown as Record<string, string> });
    expect(sentReferences(fake)?.["merchantParameters"]).toBe('{"plan":"pro"}');
    expect(info.metadata).toStrictEqual({ plan: "pro" });
    expect((await decodeSessionContext(session.pspSessionId, SIGNING_KEY)).metadata).toStrictEqual({ plan: "pro" });
  });

  it("checks the JSON that is sent, so an object's toJSON decides what is sent and a Map, whose JSON is {}, sends nothing", async () => {
    class Subscription {
      readonly internalTier = 3;
      toJSON(): Record<string, string> {
        return { plan: "pro" };
      }
    }
    const withToJson = makePair();
    const { info } = await complete(withToJson.adapter, { metadata: new Subscription() as unknown as Record<string, string> });
    expect(sentReferences(withToJson.fake)?.["merchantParameters"]).toBe('{"plan":"pro"}');
    expect(info.metadata).toStrictEqual({ plan: "pro" });

    const withMap = makePair();
    const mapped = await complete(withMap.adapter, {
      id: "order-7",
      metadata: new Map([["plan", "pro"]]) as unknown as Record<string, string>,
    });
    expect(sentReferences(withMap.fake)).toEqual({ merchantReference: "order-7" });
    expect(mapped.info).not.toHaveProperty("metadata");
    expect(await decodeSessionContext(mapped.session.pspSessionId, SIGNING_KEY)).not.toHaveProperty("metadata");
  });

  it("carries the metadata it checked, whatever the object holds once Worldline has answered the tokenization", async () => {
    const fake = new FakeWorldlineApi();
    const metadata: Record<string, unknown> = { plan: "pro" };
    const { adapter } = makePair({
      fetch: async (input, init) => {
        const response = await fake.fetch(input, init);
        if (new URL(String(input)).pathname.endsWith("/hostedtokenizations")) {
          // The host changes the object while the session is being created.
          Object.assign(metadata, { plan: "x".repeat(1200), seats: 3 });
        }
        return response;
      },
    });
    const { session, info } = await complete(adapter, { metadata: metadata as Record<string, string> });
    expect(sentReferences(fake)?.["merchantParameters"]).toBe('{"plan":"pro"}');
    expect(info.metadata).toStrictEqual({ plan: "pro" });
    expect((await decodeSessionContext(session.pspSessionId, SIGNING_KEY)).metadata).toStrictEqual({ plan: "pro" });
  });

  it("the fake rejects merchantParameters over 1000 characters that a hand-minted context carries to it", async () => {
    const { adapter, fake, fetchSpy } = makePair();
    const context = await encodeSessionContext(
      {
        v: 1,
        amount: 1000,
        currency: "EUR",
        captureMethod: "automatic",
        hostedTokenizationId: "htp_1",
        expiresAt: Date.now() + 60_000,
        returnUrl: RETURN_URL,
        metadata: metadataOfLength(1001),
      },
      SIGNING_KEY,
    );
    const error = await adapter
      .completePayment({ pspSessionId: context, clientToken: "htp_1", idempotencyKey: "complete-long" })
      .then(() => undefined, (err: unknown) => err as PayFanoutError);
    expect(error).toMatchObject({ code: "invalid_request", retryable: false });
    expect(error?.raw).toMatchObject({ errors: [{ propertyName: PROPERTY_NAME }] });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fake.uniquePaymentCreations).toBe(0);
  });

  it("the fake accepts a string of exactly 1000 characters there, and nothing longer or of another type", async () => {
    const cases: Array<[unknown, number]> = [
      ["p".repeat(1000), 201],
      ["p".repeat(1001), 400],
      [42, 400],
      [{ plan: "pro" }, 400],
      [null, 400],
    ];
    for (const [merchantParameters, status] of cases) {
      const fake = new FakeWorldlineApi();
      const response = await postCreatePayment(fake, { merchantParameters });
      expect(response.status, JSON.stringify(merchantParameters)).toBe(status);
      if (status === 400) {
        expect(response.body.errors?.[0]?.propertyName).toBe(PROPERTY_NAME);
        expect(mapWorldlineError(400, response.body).code).toBe("invalid_request");
        expect(fake.uniquePaymentCreations).toBe(0);
      }
    }
  });

  it("the fake echoes it on GetPayment and webhooks only, never on the payment a CreatePayment or CancelPayment answer carries", async () => {
    const cases: Array<[string, Parameters<typeof postCreatePayment>[2], number]> = [
      ["a sale", {}, 201],
      ["a decline's paymentResult", { amount: 1302 }, 402],
      ["a 3-D Secure challenge", { hostedTokenizationId: "htp_3ds" }, 201],
      ["an authorisation", { authorizationMode: "PRE_AUTHORIZATION" }, 201],
    ];
    for (const [label, options, status] of cases) {
      const fake = new FakeWorldlineApi();
      const answer = await postCreatePayment(fake, { merchantReference: "order-7", merchantParameters: "p=1" }, options);
      expect(answer.status, label).toBe(status);
      expect(JSON.stringify(answer.body), label).toContain('"merchantReference":"order-7"');
      expect(JSON.stringify(answer.body), label).not.toContain("merchantParameters");
      const id = answer.body.payment?.id ?? answer.body.paymentResult?.payment?.id ?? "";
      const read = (await callFake(fake, "GET", `${PAYMENTS_URL}/${id}`)).body as WorldlinePaymentLike;
      expect(read.paymentOutput?.references, label).toEqual({ merchantReference: "order-7", merchantParameters: "p=1" });
      const delivered = fake.webhookBody(id, "payment.created")["payment"] as WorldlinePaymentLike;
      expect(delivered.paymentOutput?.references, label).toEqual({ merchantReference: "order-7", merchantParameters: "p=1" });
      if (options?.authorizationMode === "PRE_AUTHORIZATION") {
        const cancelled = await callFake(fake, "POST", `${PAYMENTS_URL}/${id}/cancel`);
        expect(cancelled.status, label).toBe(200);
        expect(JSON.stringify(cancelled.body), label).not.toContain("merchantParameters");
      }
    }
  });
});

describe("the merchantParameters echo reads back only as metadata the adapter could have written", () => {
  const ignored: Array<[string, unknown]> = [
    ["the contract's key-value example", "SessionID=126548354&ShopperID=73541312"],
    ["an empty string", ""],
    ["text that is not JSON", "{plan: pro}"],
    ["a JSON array", JSON.stringify(["pro"])],
    ["a JSON string", JSON.stringify("pro")],
    ["JSON null", "null"],
    ["a JSON number", "42"],
    ["an empty JSON object", "{}"],
    ["an object with a number value", JSON.stringify({ plan: "pro", seats: 3 })],
    ["an object with a nested object", JSON.stringify({ plan: { tier: "pro" } })],
    ["an object with a null value", JSON.stringify({ plan: null })],
    ["a number instead of a string", 42],
    ["an object instead of a string", { plan: "pro" }],
    ["a boolean instead of a string", true],
    ["an array holding the metadata's JSON instead of a string", [JSON.stringify(METADATA)]],
  ];
  for (const [label, merchantParameters] of ignored) {
    it(`reads ${label} as no metadata, without throwing`, async () => {
      const payment = captured({ references: { merchantParameters } });
      const info = await readBack(payment);
      expect(info.status).toBe("succeeded");
      expect(info).not.toHaveProperty("metadata");
      expect(readWorldlineWebhookMetadata(await webhookOf(payment))).toBeUndefined();
    });
  }

  it("falls back to the deprecated paymentOutput.merchantParameters only when references carries none", async () => {
    const fromReferences = JSON.stringify({ source: "references" });
    const fromDeprecated = JSON.stringify({ source: "deprecated" });
    const cases: Array<[string, Record<string, unknown>, Record<string, string> | undefined]> = [
      ["only the deprecated field", { merchantParameters: fromDeprecated }, { source: "deprecated" }],
      [
        "references without merchantParameters",
        { references: { merchantReference: "order-1" }, merchantParameters: fromDeprecated },
        { source: "deprecated" },
      ],
      [
        "references.merchantParameters null",
        { references: { merchantParameters: null }, merchantParameters: fromDeprecated },
        { source: "deprecated" },
      ],
      [
        "references that is not an object",
        { references: "order-1", merchantParameters: fromDeprecated },
        { source: "deprecated" },
      ],
      [
        "both fields",
        { references: { merchantParameters: fromReferences }, merchantParameters: fromDeprecated },
        { source: "references" },
      ],
      [
        "a references echo that is not metadata",
        { references: { merchantParameters: "SessionID=126548354" }, merchantParameters: fromDeprecated },
        undefined,
      ],
      ["an empty references echo", { references: { merchantParameters: "" }, merchantParameters: fromDeprecated }, undefined],
    ];
    for (const [label, paymentOutput, expected] of cases) {
      const payment = captured(paymentOutput);
      expect((await readBack(payment)).metadata, label).toEqual(expected);
      expect(readWorldlineWebhookMetadata(await webhookOf(payment)), label).toEqual(expected);
    }
  });

  it("reads nothing from another PSP's event, a delivery without a payment, or a payment without output", async () => {
    const event = await webhookOf(captured({ references: { merchantParameters: JSON.stringify(METADATA) } }));
    expect(readWorldlineWebhookMetadata(event)).toEqual(METADATA);
    expect(readWorldlineWebhookMetadata({ ...event, pspName: "stripe" })).toBeUndefined();
    const refundOnly = await parseWorldlineWebhookEvent(
      JSON.stringify({
        id: "evt_2",
        type: "refund.refunded",
        refund: { id: "ref_1", refundOutput: { references: { merchantParameters: JSON.stringify(METADATA) } } },
      }),
    );
    expect(readWorldlineWebhookMetadata(refundOnly)).toBeUndefined();
    for (const raw of [undefined, null, "raw", { payment: null }, { payment: "pay_1" }, { payment: { id: "pay_1" } }]) {
      expect(readWorldlineWebhookMetadata({ ...event, raw }), JSON.stringify(raw)).toBeUndefined();
    }
  });
});

describe("createdAt comes from paymentOutput.transactionDate", () => {
  const readable: Array<[string, string]> = [
    ["2026-09-26T10:15:30Z", "2026-09-26T10:15:30.000Z"],
    ["2026-09-26T10:15:30.5Z", "2026-09-26T10:15:30.500Z"],
    ["2026-09-26T10:15:30.1239876Z", "2026-09-26T10:15:30.123Z"],
    ["2026-09-26T12:15:30+02:00", "2026-09-26T10:15:30.000Z"],
    ["2026-09-26T08:45:30.25-01:30", "2026-09-26T10:15:30.250Z"],
    // Hour-only offsets, which Worldline's Java SDK reads.
    ["2026-09-26T12:15:30+02", "2026-09-26T10:15:30.000Z"],
    ["2026-09-26T09:15:30.5-01", "2026-09-26T10:15:30.500Z"],
    ["2026-09-26T10:15:30-00:00", "2026-09-26T10:15:30.000Z"],
    ["2026-09-27T00:30:00+01:00", "2026-09-26T23:30:00.000Z"],
    ["1999-12-31T23:30:00-01:00", "2000-01-01T00:30:00.000Z"],
    ["2028-02-29T23:59:59Z", "2028-02-29T23:59:59.000Z"],
  ];
  for (const [transactionDate, expected] of readable) {
    it(`reads ${transactionDate} as ${expected}`, async () => {
      expect((await readBack(captured({ transactionDate }))).createdAt).toBe(expected);
    });
  }

  it("reads a transactionDate with a zone alike whatever the server's time zone, and one without a zone as none", async () => {
    const previous = process.env.TZ;
    process.env.TZ = "Asia/Kolkata";
    try {
      expect(new Date(2026, 8, 26).getTimezoneOffset()).toBe(-330);
      expect((await readBack(captured({ transactionDate: "2026-09-26T10:15:30Z" }))).createdAt).toBe("2026-09-26T10:15:30.000Z");
      expect((await readBack(captured({ transactionDate: "2026-09-26T10:15:30" }))).createdAt).toBe(EPOCH);
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  const unreadable: Array<[string, unknown]> = [
    ["no time zone", "2026-09-26T10:15:30"],
    ["no time zone, with a fraction", "2026-09-26T10:15:30.1239876"],
    ["a February 30", "2026-02-30T10:15:30Z"],
    ["a February 29 outside a leap year", "2026-02-29T10:15:30Z"],
    ["a September 31", "2026-09-31T10:15:30Z"],
    ["a 13th month", "2026-13-01T10:15:30Z"],
    ["month 00", "2026-00-15T10:15:30Z"],
    ["year 0099, which Date.UTC would take for 1999", "0099-09-26T10:15:30Z"],
    ["hour 24", "2026-09-26T24:00:00Z"],
    ["minute 60", "2026-09-26T10:60:30Z"],
    ["a leap second", "2026-06-30T23:59:60Z"],
    ["second 60 mid-month, which the day check alone would let through", "2026-09-26T10:15:60Z"],
    ["a space instead of the T", "2026-09-26 10:15:30Z"],
    ["a date without a time", "2026-09-26"],
    ["text before the date", "x2026-09-26T10:15:30Z"],
    ["text after the zone", "2026-09-26T10:15:30Zx"],
    ["an offset of 24 hours", "2026-09-26T10:15:30+24:00"],
    ["an hour-only offset of 24", "2026-09-26T10:15:30+24"],
    ["an offset of 60 minutes", "2026-09-26T10:15:30+02:60"],
    ["an offset without a colon", "2026-09-26T10:15:30+0200"],
    ["a colon without offset minutes", "2026-09-26T10:15:30+02:"],
    ["a one-digit offset", "2026-09-26T10:15:30+2"],
    ["a decimal point without digits", "2026-09-26T10:15:30.Z"],
    ["a lower-case zone", "2026-09-26T10:15:30z"],
    ["another format", "26/09/2026 10:15:30"],
    ["an empty string", ""],
    ["epoch milliseconds", 1790410530000],
    ["null", null],
    ["an object", { value: "2026-09-26T10:15:30Z" }],
    ["an array holding a date", ["2026-09-26T10:15:30Z"]],
  ];
  for (const [label, transactionDate] of unreadable) {
    it(`keeps the 1970 placeholder for ${label}`, async () => {
      expect((await readBack(captured({ transactionDate }))).createdAt).toBe(EPOCH);
    });
  }

  it("keeps the 1970 placeholder when the payment reports no transactionDate", async () => {
    expect((await readBack(captured({}))).createdAt).toBe(EPOCH);
    expect((await readBack({ id: "pay_bare" })).createdAt).toBe(EPOCH);
  });

  it("reads the fake's creation stamp on completion, and after a capture, which leaves it", async () => {
    const { adapter, fake } = makePair();
    fake.clock = Date.UTC(2026, 8, 26, 10, 15, 30, 789);
    const { info } = await complete(adapter, { captureMethod: "manual" });
    expect(info.status).toBe("requires_capture");
    expect(info.createdAt).toBe("2026-09-26T10:15:30.000Z");
    const capturedInfo = await adapter.capturePayment(info.pspPaymentId, undefined, "capture-1");
    expect(capturedInfo.status).toBe("succeeded");
    expect(capturedInfo.createdAt).toBe("2026-09-26T10:15:30.000Z");
  });
});
