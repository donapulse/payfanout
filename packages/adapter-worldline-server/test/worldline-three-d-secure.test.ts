import { describe, expect, it, vi } from "vitest";
import { isPayFanoutError, type CreatePaymentSessionInput, type PayFanoutError } from "@payfanout/core";
import {
  decodeWorldlineClientToken,
  deriveIdempotenceKey,
  encodeSessionContext,
  mapWorldlineError,
  WorldlineServerAdapter,
  type WorldlineCustomerDevice,
  type WorldlineServerAdapterConfig,
} from "../src/index.js";
import { FakeWorldlineApi } from "./fake-worldline-api.js";

const SIGNING_KEY = "session-signing-key";
const RETURN_URL = "https://host.example/return";
const DEFAULT_RETURN_URL = "https://host.example/default-return";
const PAYMENTS_URL = "https://payment.preprod.direct.worldline-solutions.com/v2/mid-1/payments";

const DEVICE: WorldlineCustomerDevice = {
  locale: "fr-BE",
  timezoneOffsetUtcMinutes: "-120",
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/130.0",
  browserData: { colorDepth: 24, javaEnabled: false, javaScriptEnabled: true, screenHeight: "1080", screenWidth: "1920" },
};

function envelope(hostedTokenizationId: unknown, device?: unknown): string {
  return JSON.stringify({ hostedTokenizationId, ...(device !== undefined ? { device } : {}) });
}

function makePair(config: Partial<WorldlineServerAdapterConfig> = {}) {
  const fake = new FakeWorldlineApi();
  const fetchSpy = vi.fn(fake.fetch);
  const adapter = new WorldlineServerAdapter({
    apiKeyId: "api-key-id",
    secretApiKey: "secret-api-key",
    merchantId: "mid-1",
    environment: "sandbox",
    sessionSigningKey: SIGNING_KEY,
    webhookKeys: [{ keyId: "wh-key-1", secretKey: "webhook-secret" }],
    fetch: fetchSpy,
    ...config,
  });
  return { adapter, fake, fetchSpy };
}

async function complete(
  adapter: WorldlineServerAdapter,
  session: Partial<CreatePaymentSessionInput>,
  clientToken = envelope("htp_1", DEVICE),
) {
  const created = await adapter.createPaymentSession({
    amount: 2500,
    currency: "EUR",
    returnUrl: RETURN_URL,
    idempotencyKey: "session-1",
    ...session,
  });
  return adapter.completePayment({ pspSessionId: created.pspSessionId, clientToken, idempotencyKey: "complete-1" });
}

function createPaymentBody(fake: FakeWorldlineApi) {
  return fake.lastCreatePaymentBody as {
    hostedTokenizationId?: string;
    order: { amountOfMoney?: unknown; references?: Record<string, string>; customer?: Record<string, unknown> };
    cardPaymentMethodSpecificInput: Record<string, unknown> & { threeDSecure?: Record<string, unknown> };
  };
}

/** Every CreatePayment card input the adapter sent, in order. */
function sentCardInputs(fetchSpy: ReturnType<typeof makePair>["fetchSpy"]): Array<Record<string, unknown>> {
  return fetchSpy.mock.calls
    .filter(([url, init]) => String(url) === PAYMENTS_URL && init?.method === "POST")
    .map(([, init]) => JSON.parse(String(init?.body)) as { cardPaymentMethodSpecificInput: Record<string, unknown> })
    .map((body) => body.cardPaymentMethodSpecificInput);
}

/** The Cartes Bancaires input every card payment carries: the use case alone. */
const CARTES_BANCAIRES_INPUT = { threeDSecure: { usecase: "single-amount" } };

function thrownBy(run: () => unknown): PayFanoutError {
  try {
    run();
  } catch (err) {
    if (isPayFanoutError(err)) return err;
    throw err;
  }
  throw new Error("expected a PayFanoutError");
}

function describeValue(value: unknown): string {
  return typeof value === "string" && value.length > 20 ? `a ${value.length}-character string` : JSON.stringify(value);
}

function urlOfLength(length: number): string {
  const base = "https://host.example/return/";
  return base + "r".repeat(length - base.length);
}

/** A CreatePayment body within every documented limit, as the adapter sends it. */
function paymentBody(
  overrides: { hostedTokenizationId?: string; order?: Record<string, unknown>; card?: Record<string, unknown> } = {},
) {
  return {
    order: { amountOfMoney: { amount: 1000, currencyCode: "EUR" }, ...overrides.order },
    hostedTokenizationId: overrides.hostedTokenizationId ?? "htp_1",
    cardPaymentMethodSpecificInput: {
      authorizationMode: "SALE",
      returnUrl: RETURN_URL,
      threeDSecure: { skipAuthentication: false, redirectionData: { returnUrl: RETURN_URL } },
      paymentProduct130SpecificInput: CARTES_BANCAIRES_INPUT,
      ...overrides.card,
    },
  };
}

/** Sends a CreatePayment straight to the fake, bypassing the adapter's own checks. */
async function postCreatePayment(fake: FakeWorldlineApi, body: unknown) {
  const response = await fake.fetch(PAYMENTS_URL, {
    method: "POST",
    headers: { authorization: "GCS v1HMAC:api-key-id:signature", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as { errors?: Array<{ propertyName?: string }> } };
}

describe("decodeWorldlineClientToken", () => {
  it("decodes the confirm() envelope into the hostedTokenizationId and the device data", () => {
    expect(decodeWorldlineClientToken(envelope("htp_1", DEVICE))).toEqual({ hostedTokenizationId: "htp_1", device: DEVICE });
    expect(decodeWorldlineClientToken(`  \n${envelope("htp_1", DEVICE)}`)).toEqual({
      hostedTokenizationId: "htp_1",
      device: DEVICE,
    });
  });

  it("decodes the exact wire format the client adapter's confirm() produces", () => {
    const fromConfirm =
      '{"hostedTokenizationId":"htp_123","device":{"locale":"fr-BE","timezoneOffsetUtcMinutes":"-120",' +
      '"userAgent":"Mozilla/5.0 (test)","browserData":{"colorDepth":24,"javaEnabled":false,' +
      '"javaScriptEnabled":true,"screenHeight":"1080","screenWidth":"1920"}}}';
    expect(decodeWorldlineClientToken(fromConfirm)).toEqual({
      hostedTokenizationId: "htp_123",
      device: {
        locale: "fr-BE",
        timezoneOffsetUtcMinutes: "-120",
        userAgent: "Mozilla/5.0 (test)",
        browserData: { colorDepth: 24, javaEnabled: false, javaScriptEnabled: true, screenHeight: "1080", screenWidth: "1920" },
      },
    });
  });

  it("uses a bare hostedTokenizationId as-is (earlier client adapters, hand-written callers)", () => {
    const decoded = decodeWorldlineClientToken("0a1b2c3d4e5f60718293a4b5c6d7e8f9");
    expect(decoded).toEqual({ hostedTokenizationId: "0a1b2c3d4e5f60718293a4b5c6d7e8f9" });
    expect(decoded).not.toHaveProperty("device");
  });

  it("decodes an envelope without device data to the id alone", () => {
    expect(decodeWorldlineClientToken(envelope("htp_1"))).toEqual({ hostedTokenizationId: "htp_1" });
  });

  it("rejects an empty token with invalid_request", () => {
    for (const token of ["", "   ", undefined]) {
      expect(thrownBy(() => decodeWorldlineClientToken(token as string))).toMatchObject({
        code: "invalid_request",
        retryable: false,
      });
    }
  });

  it("rejects an envelope that is not valid JSON, with the parse error as the diagnostic", () => {
    const error = thrownBy(() => decodeWorldlineClientToken('{"hostedTokenizationId":"htp_1"'));
    expect(error.code).toBe("invalid_request");
    expect(error.raw).toBeInstanceOf(SyntaxError);
  });

  it("rejects an envelope without a non-empty string hostedTokenizationId", () => {
    for (const token of ['{"device":{}}', envelope(""), envelope(42), envelope(null), envelope({ id: "htp_1" })]) {
      const error = thrownBy(() => decodeWorldlineClientToken(token));
      expect(error.code).toBe("invalid_request");
      expect(error.raw).toHaveProperty("hostedTokenizationId");
    }
  });

  it("rejects an envelope whose hostedTokenizationId is blank, as it does a blank bare token", () => {
    for (const blank of [" ", "   ", "\n\t "]) {
      const error = thrownBy(() => decodeWorldlineClientToken(envelope(blank, DEVICE)));
      expect(error).toMatchObject({ code: "invalid_request", retryable: false });
      expect(error.raw).toEqual({ hostedTokenizationId: blank });
    }
  });

  it("ignores a device that is not an object", () => {
    for (const device of [null, "fr-BE", 42, ["fr-BE"], true]) {
      expect(decodeWorldlineClientToken(envelope("htp_1", device))).toEqual({ hostedTokenizationId: "htp_1" });
    }
  });

  it("keeps every field at its contract limit", () => {
    const atLimits = {
      locale: "l".repeat(35),
      timezoneOffsetUtcMinutes: "-12345",
      userAgent: "u".repeat(2048),
      browserData: { colorDepth: 99, javaEnabled: true, javaScriptEnabled: false, screenHeight: "999999", screenWidth: "0" },
    };
    expect(decodeWorldlineClientToken(envelope("htp_1", atLimits)).device).toEqual(atLimits);
    const lowest = { ...atLimits, timezoneOffsetUtcMinutes: "0", browserData: { ...atLimits.browserData, colorDepth: 0 } };
    expect(decodeWorldlineClientToken(envelope("htp_1", lowest)).device).toEqual(lowest);
  });

  const BROWSER_DATA_FIELDS = new Set(["colorDepth", "javaEnabled", "javaScriptEnabled", "screenHeight", "screenWidth"]);
  const invalidFields: Array<{ field: string; values: unknown[] }> = [
    { field: "locale", values: ["", "l".repeat(36), 5, null, { tag: "fr" }] },
    { field: "timezoneOffsetUtcMinutes", values: [-120, "", "+60", "1.5", "123456", "-123456", "abc", " -120", null] },
    { field: "userAgent", values: ["", "u".repeat(2049), {}, 7] },
    { field: "colorDepth", values: [-1, 100, 24.5, "24", null, true] },
    { field: "javaEnabled", values: ["true", 1, null] },
    { field: "javaScriptEnabled", values: ["yes", 0, null] },
    { field: "screenHeight", values: [1080, "", "-1", "10.5", "1234567", "1e3", " 1080", null] },
    { field: "screenWidth", values: [1920, "", "-1", "19.2", "1234567", "0x10", null] },
  ];
  for (const { field, values } of invalidFields) {
    for (const value of values) {
      it(`drops ${field} = ${describeValue(value)} and keeps every other field`, () => {
        const inBrowserData = BROWSER_DATA_FIELDS.has(field);
        const sent = inBrowserData
          ? { ...DEVICE, browserData: { ...DEVICE.browserData, [field]: value } }
          : { ...DEVICE, [field]: value };
        const expected = structuredClone(DEVICE) as Record<string, unknown> & { browserData: Record<string, unknown> };
        if (inBrowserData) delete expected.browserData[field];
        else delete expected[field];
        expect(decodeWorldlineClientToken(envelope("htp_1", sent)).device).toEqual(expected);
      });
    }
  }

  it("keeps only the device fields a browser can read, refusing the acceptHeader, ipAddress and deviceFingerprint Worldline defines", () => {
    const sent = { ...DEVICE, acceptHeader: "text/html", ipAddress: "203.0.113.7", deviceFingerprint: "fp-1" };
    expect(decodeWorldlineClientToken(envelope("htp_1", sent)).device).toEqual(DEVICE);
  });

  it("drops keys Worldline does not define, on the device and in browserData", () => {
    const sent = {
      ...DEVICE,
      extra: { nested: true },
      browserData: { ...DEVICE.browserData, innerWidth: 1200, innerHeight: 800 },
    };
    expect(decodeWorldlineClientToken(envelope("htp_1", sent)).device).toEqual(DEVICE);
  });

  it("omits browserData, then the whole device, once nothing in them survives", () => {
    expect(decodeWorldlineClientToken(envelope("htp_1", { locale: "fr-BE", browserData: { colorDepth: 500 } }))).toEqual({
      hostedTokenizationId: "htp_1",
      device: { locale: "fr-BE" },
    });
    for (const device of [{}, { locale: "", browserData: { colorDepth: 500 } }, { browserData: "24-bit" }, { ipAddress: "203.0.113.7" }]) {
      expect(decodeWorldlineClientToken(envelope("htp_1", device))).toEqual({ hostedTokenizationId: "htp_1" });
    }
  });
});

describe("completePayment sends Worldline's mandatory 3-D Secure data", () => {
  it("sends the sanitized device data as order.customer.device, next to the billing and contact data", async () => {
    const { adapter, fake } = makePair();
    await complete(
      adapter,
      {
        billingDetails: { name: "Ann Buyer", address: { line1: "1 Way", city: "Brussels", postalCode: "1000", country: "BE" } },
        receiptEmail: "buyer@example.com",
      },
      envelope("htp_device", { ...DEVICE, ipAddress: "203.0.113.7", browserData: { ...DEVICE.browserData, colorDepth: 512 } }),
    );
    const body = createPaymentBody(fake);
    expect(body.hostedTokenizationId).toBe("htp_device");
    expect(body.order.customer).toEqual({
      billingAddress: { street: "1 Way", city: "Brussels", zip: "1000", countryCode: "BE" },
      personalInformation: { name: { firstName: "Ann", surname: "Buyer" } },
      contactDetails: { emailAddress: "buyer@example.com" },
      device: {
        locale: "fr-BE",
        timezoneOffsetUtcMinutes: "-120",
        userAgent: DEVICE.userAgent,
        browserData: { javaEnabled: false, javaScriptEnabled: true, screenHeight: "1080", screenWidth: "1920" },
      },
    });
  });

  it("sends skipAuthentication false and the return URL in both forms, never the deprecated flat skipAuthentication", async () => {
    const { adapter, fake } = makePair();
    await complete(adapter, {});
    expect(createPaymentBody(fake).cardPaymentMethodSpecificInput).toEqual({
      authorizationMode: "SALE",
      returnUrl: RETURN_URL,
      threeDSecure: { skipAuthentication: false, redirectionData: { returnUrl: RETURN_URL } },
      paymentProduct130SpecificInput: CARTES_BANCAIRES_INPUT,
    });
  });

  const scaCases: Array<[CreatePaymentSessionInput["sca"], { challengeIndicator?: string; transactionChannel?: string }]> = [
    [{ challenge: "force" }, { challengeIndicator: "challenge-required" }],
    [{ challenge: "force", exemption: "moto" }, { challengeIndicator: "challenge-required", transactionChannel: "MOTO" }],
    [{ challenge: "automatic" }, {}],
    [{ challenge: "automatic", exemption: "moto" }, { transactionChannel: "MOTO" }],
    [{ exemption: "moto" }, { transactionChannel: "MOTO" }],
    [{}, {}],
    [undefined, {}],
  ];
  for (const [sca, { challengeIndicator, transactionChannel }] of scaCases) {
    const channel = transactionChannel ? `transactionChannel ${transactionChannel}` : "no transactionChannel";
    it(`maps sca ${JSON.stringify(sca) ?? "absent"} to ${challengeIndicator ?? "no challengeIndicator"} and ${channel}, with the same 3-D Secure data`, async () => {
      const { adapter, fake } = makePair();
      const info = await complete(adapter, sca ? { sca } : {});
      expect(info.status).toBe("succeeded");
      expect(createPaymentBody(fake).cardPaymentMethodSpecificInput).toEqual({
        authorizationMode: "SALE",
        ...(transactionChannel ? { transactionChannel } : {}),
        returnUrl: RETURN_URL,
        threeDSecure: {
          skipAuthentication: false,
          redirectionData: { returnUrl: RETURN_URL },
          ...(challengeIndicator ? { challengeIndicator } : {}),
        },
        paymentProduct130SpecificInput: CARTES_BANCAIRES_INPUT,
      });
    });
  }

  it("sends the statement descriptor as softDescriptor, never the deprecated descriptor", async () => {
    const { adapter, fake } = makePair();
    const info = await complete(adapter, { id: "order-77", statementDescriptor: "SHOP ORDER 77" });
    expect(info.id).toBe("order-77");
    expect(createPaymentBody(fake).order.references).toEqual({ merchantReference: "order-77", softDescriptor: "SHOP ORDER 77" });
  });

  it("forwards the decoded hostedTokenizationId, never the envelope an earlier server adapter sent whole", async () => {
    const forwardedWhole = await postCreatePayment(
      new FakeWorldlineApi(),
      paymentBody({ hostedTokenizationId: envelope("htp_1", DEVICE) }),
    );
    expect(forwardedWhole.status).toBe(400);
    expect(forwardedWhole.body.errors?.[0]?.propertyName).toBe("hostedTokenizationId");

    const { adapter, fake } = makePair();
    const info = await complete(adapter, {}, envelope("htp_1", DEVICE));
    expect(info.status).toBe("succeeded");
    expect(createPaymentBody(fake).hostedTokenizationId).toBe("htp_1");
  });

  it("sends no device data for a bare hostedTokenizationId", async () => {
    const withEmail = makePair();
    await complete(withEmail.adapter, { receiptEmail: "buyer@example.com" }, "htp_legacy");
    const body = createPaymentBody(withEmail.fake);
    expect(body.hostedTokenizationId).toBe("htp_legacy");
    expect(body.order.customer).toEqual({ contactDetails: { emailAddress: "buyer@example.com" } });

    const bare = makePair();
    await complete(bare.adapter, {}, "htp_legacy");
    expect(createPaymentBody(bare.fake).order).not.toHaveProperty("customer");
  });

  it("surfaces a challenge as requires_action when the clientToken is the envelope", async () => {
    const { adapter, fake } = makePair();
    const info = await complete(adapter, {}, envelope("htp_3ds", DEVICE));
    expect(info.status).toBe("requires_action");
    const raw = info.raw as { merchantAction?: { redirectData?: { redirectURL?: string } } };
    expect(raw.merchantAction?.redirectData?.redirectURL).toContain("3ds");
    expect(createPaymentBody(fake).order.customer).toEqual({ device: DEVICE });
  });

  it("still sends the derived X-GCS-Idempotence-Key on CreatePayment", async () => {
    const { adapter, fetchSpy } = makePair();
    await complete(adapter, {});
    const call = fetchSpy.mock.calls.find(([url, init]) => String(url).endsWith("/payments") && init?.method === "POST");
    const headers = call?.[1]?.headers as Record<string, string> | undefined;
    expect(headers?.["X-GCS-Idempotence-Key"]).toBe(await deriveIdempotenceKey("complete-1"));
  });

  it("keeps integer minor units for zero- and three-decimal currencies", async () => {
    for (const [amount, currency] of [
      [500, "JPY"],
      [1234, "BHD"],
    ] as const) {
      const { adapter, fake } = makePair();
      const info = await complete(adapter, { amount, currency });
      expect(info.amount).toBe(amount);
      expect(createPaymentBody(fake).order.amountOfMoney).toEqual({ amount, currencyCode: currency });
    }
  });
});

describe("every card payment carries the Cartes Bancaires use case", () => {
  const completions: Array<[string, Partial<CreatePaymentSessionInput>, string, string]> = [
    ["an automatic-capture payment", {}, envelope("htp_1", DEVICE), "succeeded"],
    ["a manual-capture payment", { captureMethod: "manual" }, envelope("htp_1", DEVICE), "requires_capture"],
    ["a payment met with a 3-D Secure challenge", {}, envelope("htp_3ds", DEVICE), "requires_action"],
    ["a payment forcing a challenge", { sca: { challenge: "force" } }, envelope("htp_1", DEVICE), "succeeded"],
    ["a MOTO payment", { sca: { exemption: "moto" } }, envelope("htp_1", DEVICE), "succeeded"],
    ["a JPY payment", { amount: 500, currency: "JPY" }, envelope("htp_1", DEVICE), "succeeded"],
    ["a BHD payment", { amount: 1234, currency: "BHD" }, envelope("htp_1", DEVICE), "succeeded"],
    ["a bare hostedTokenizationId", {}, "htp_legacy", "succeeded"],
  ];
  for (const [name, session, clientToken, status] of completions) {
    it(`sends usecase "single-amount" and no other Cartes Bancaires data on ${name}`, async () => {
      const { adapter, fetchSpy } = makePair();
      const info = await complete(adapter, session, clientToken);
      expect(info.status).toBe(status);
      const sent = sentCardInputs(fetchSpy);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toHaveProperty("paymentProduct130SpecificInput", CARTES_BANCAIRES_INPUT);
    });
  }

  it("sends it on every CreatePayment of a completion that walks past a decline, the declined attempt and the replay included", async () => {
    const { adapter, fake, fetchSpy } = makePair();
    fake.declinedCards.add("htp_declined");
    const session = await adapter.createPaymentSession({ amount: 2500, currency: "EUR", returnUrl: RETURN_URL, idempotencyKey: "session-1" });
    const input = { pspSessionId: session.pspSessionId, idempotencyKey: "complete-1" };
    await expect(adapter.completePayment({ ...input, clientToken: envelope("htp_declined", DEVICE) })).rejects.toMatchObject({
      code: "card_declined",
    });
    expect((await adapter.completePayment({ ...input, clientToken: envelope("htp_new_card", DEVICE) })).status).toBe("succeeded");
    expect(fake.createPaymentLog.map(({ replayed }) => replayed)).toEqual([false, true, false]);
    const sent = sentCardInputs(fetchSpy);
    expect(sent).toHaveLength(3);
    for (const card of sent) expect(card).toHaveProperty("paymentProduct130SpecificInput", CARTES_BANCAIRES_INPUT);
  });
});

describe("sca.exemption moto sends Worldline's MOTO channel", () => {
  it("keeps the 3-D Secure data, so a MOTO payment Worldline challenges still comes back as requires_action", async () => {
    const { adapter, fake } = makePair();
    const info = await complete(adapter, { sca: { exemption: "moto" } }, envelope("htp_3ds", DEVICE));
    expect(info.status).toBe("requires_action");
    const card = createPaymentBody(fake).cardPaymentMethodSpecificInput;
    expect(card).toHaveProperty("transactionChannel", "MOTO");
    expect(card.threeDSecure).toEqual({ skipAuthentication: false, redirectionData: { returnUrl: RETURN_URL } });
    expect(card).toHaveProperty("returnUrl", RETURN_URL);
    expect(createPaymentBody(fake).order.customer).toEqual({ device: DEVICE });
  });

  it("sends the channel on every CreatePayment of a MOTO completion that walks past a decline", async () => {
    const { adapter, fake, fetchSpy } = makePair();
    fake.declinedCards.add("htp_declined");
    const session = await adapter.createPaymentSession({
      amount: 2500,
      currency: "EUR",
      returnUrl: RETURN_URL,
      sca: { exemption: "moto" },
      idempotencyKey: "session-1",
    });
    const input = { pspSessionId: session.pspSessionId, idempotencyKey: "complete-1" };
    await expect(adapter.completePayment({ ...input, clientToken: envelope("htp_declined", DEVICE) })).rejects.toMatchObject({
      code: "card_declined",
    });
    expect((await adapter.completePayment({ ...input, clientToken: envelope("htp_new_card", DEVICE) })).status).toBe("succeeded");
    const sent = sentCardInputs(fetchSpy);
    expect(sent).toHaveLength(3);
    for (const card of sent) {
      expect(card).toHaveProperty("transactionChannel", "MOTO");
      expect(card).toHaveProperty("threeDSecure", { skipAuthentication: false, redirectionData: { returnUrl: RETURN_URL } });
    }
  });

  it("completes a MOTO session under manual capture as an authorisation on the MOTO channel", async () => {
    const { adapter, fake } = makePair();
    const info = await complete(adapter, { sca: { exemption: "moto" }, captureMethod: "manual" });
    expect(info.status).toBe("requires_capture");
    expect(createPaymentBody(fake).cardPaymentMethodSpecificInput).toMatchObject({
      authorizationMode: "PRE_AUTHORIZATION",
      transactionChannel: "MOTO",
    });
  });

  const withoutMoto: Array<[string, CreatePaymentSessionInput["sca"]]> = [
    ["no sca", undefined],
    ["an empty sca", {}],
    ["sca.challenge force", { challenge: "force" }],
    ["sca.challenge automatic", { challenge: "automatic" }],
    // Core's type knows only "moto"; a value from elsewhere must not pick a channel.
    ["an exemption other than moto", { exemption: "low-value" } as unknown as CreatePaymentSessionInput["sca"]],
  ];
  for (const [name, sca] of withoutMoto) {
    it(`sends no transactionChannel, and so Worldline's ECOMMERCE default, for ${name}`, async () => {
      const { adapter, fetchSpy } = makePair();
      await complete(adapter, sca ? { sca } : {});
      const [card] = sentCardInputs(fetchSpy);
      expect(card).toBeDefined();
      expect(card).not.toHaveProperty("transactionChannel");
      expect(card?.["threeDSecure"]).not.toHaveProperty("exemptionRequest");
    });
  }
});

describe("the 3-D Secure return URL is mandatory", () => {
  it("refuses a session with neither returnUrl nor defaultReturnUrl before any call to Worldline", async () => {
    const { adapter, fetchSpy } = makePair();
    const error = await adapter
      .createPaymentSession({ amount: 1000, currency: "EUR", idempotencyKey: "k" })
      .then(() => undefined, (err: unknown) => err);
    expect(error).toMatchObject({ code: "invalid_request", retryable: false });
    expect((error as PayFanoutError).message).toMatch(/defaultReturnUrl/);
    expect((error as PayFanoutError).raw).toEqual({
      propertyName: "cardPaymentMethodSpecificInput.threeDSecure.redirectionData.returnUrl",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("falls back to defaultReturnUrl, and a session's own returnUrl wins over it", async () => {
    const fallback = makePair({ defaultReturnUrl: DEFAULT_RETURN_URL });
    await complete(fallback.adapter, { returnUrl: undefined });
    expect(createPaymentBody(fallback.fake).cardPaymentMethodSpecificInput).toMatchObject({
      returnUrl: DEFAULT_RETURN_URL,
      threeDSecure: { redirectionData: { returnUrl: DEFAULT_RETURN_URL } },
    });

    const own = makePair({ defaultReturnUrl: DEFAULT_RETURN_URL });
    await complete(own.adapter, { returnUrl: RETURN_URL });
    expect(createPaymentBody(own.fake).cardPaymentMethodSpecificInput).toMatchObject({
      returnUrl: RETURN_URL,
      threeDSecure: { redirectionData: { returnUrl: RETURN_URL } },
    });
  });

  it("treats an empty returnUrl as none: defaultReturnUrl applies, and without one the session is refused as missing", async () => {
    const fallback = makePair({ defaultReturnUrl: DEFAULT_RETURN_URL });
    await complete(fallback.adapter, { returnUrl: "" });
    expect(createPaymentBody(fallback.fake).cardPaymentMethodSpecificInput).toMatchObject({
      returnUrl: DEFAULT_RETURN_URL,
      threeDSecure: { redirectionData: { returnUrl: DEFAULT_RETURN_URL } },
    });

    const { adapter, fetchSpy } = makePair();
    const error = await adapter
      .createPaymentSession({ amount: 1000, currency: "EUR", returnUrl: "", idempotencyKey: "k" })
      .then(() => undefined, (err: unknown) => err as PayFanoutError);
    expect(error).toMatchObject({ code: "invalid_request", retryable: false });
    expect(error?.message).toMatch(/defaultReturnUrl/);
    expect(error?.message).not.toMatch(/protocol/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("completes a context carrying an empty returnUrl through defaultReturnUrl", async () => {
    const context = await encodeSessionContext(
      {
        v: 1,
        amount: 1000,
        currency: "EUR",
        captureMethod: "automatic",
        hostedTokenizationId: "htp_old",
        expiresAt: Date.now() + 60_000,
        returnUrl: "",
      },
      SIGNING_KEY,
    );
    const input = { pspSessionId: context, clientToken: envelope("htp_old", DEVICE), idempotencyKey: "complete-empty" };

    const withoutDefault = makePair();
    await expect(withoutDefault.adapter.completePayment(input)).rejects.toMatchObject({ code: "invalid_request" });
    expect(withoutDefault.fetchSpy).not.toHaveBeenCalled();

    const withDefault = makePair({ defaultReturnUrl: DEFAULT_RETURN_URL });
    expect((await withDefault.adapter.completePayment(input)).status).toBe("succeeded");
    expect(createPaymentBody(withDefault.fake).cardPaymentMethodSpecificInput).toMatchObject({
      returnUrl: DEFAULT_RETURN_URL,
      threeDSecure: { redirectionData: { returnUrl: DEFAULT_RETURN_URL } },
    });
  });

  it("completes a context signed before the return URL was mandatory only through defaultReturnUrl", async () => {
    const legacyContext = await encodeSessionContext(
      { v: 1, amount: 1000, currency: "EUR", captureMethod: "automatic", hostedTokenizationId: "htp_old", expiresAt: Date.now() + 60_000 },
      SIGNING_KEY,
    );
    const input = { pspSessionId: legacyContext, clientToken: envelope("htp_old", DEVICE), idempotencyKey: "complete-old" };

    const withoutDefault = makePair();
    await expect(withoutDefault.adapter.completePayment(input)).rejects.toMatchObject({ code: "invalid_request" });
    expect(withoutDefault.fetchSpy).not.toHaveBeenCalled();

    const withDefault = makePair({ defaultReturnUrl: DEFAULT_RETURN_URL });
    const info = await withDefault.adapter.completePayment(input);
    expect(info.status).toBe("succeeded");
    expect(createPaymentBody(withDefault.fake).cardPaymentMethodSpecificInput).toMatchObject({ returnUrl: DEFAULT_RETURN_URL });
  });
});

describe("order references follow Worldline's limits", () => {
  it("refuses an id longer than merchantReference's 40 characters before any call to Worldline", async () => {
    const { adapter, fetchSpy } = makePair();
    await expect(
      adapter.createPaymentSession({ id: "o".repeat(41), amount: 1000, currency: "EUR", returnUrl: RETURN_URL, idempotencyKey: "k" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetchSpy).not.toHaveBeenCalled();

    const atLimit = makePair();
    const info = await complete(atLimit.adapter, { id: "o".repeat(40) });
    expect(info.id).toBe("o".repeat(40));
  });

  it("refuses a statementDescriptor longer than softDescriptor's 256 characters before any call to Worldline", async () => {
    const { adapter, fetchSpy } = makePair();
    await expect(
      adapter.createPaymentSession({
        amount: 1000,
        currency: "EUR",
        returnUrl: RETURN_URL,
        statementDescriptor: "d".repeat(257),
        idempotencyKey: "k",
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetchSpy).not.toHaveBeenCalled();

    const atLimit = makePair();
    await complete(atLimit.adapter, { statementDescriptor: "d".repeat(256) });
    expect(createPaymentBody(atLimit.fake).order.references).toEqual({ softDescriptor: "d".repeat(256) });
  });
});

describe("the fake enforces the documented limits the adapter relies on", () => {
  async function expectRejection(body: unknown, propertyName: string): Promise<void> {
    const fake = new FakeWorldlineApi();
    const response = await postCreatePayment(fake, body);
    expect(response.status).toBe(400);
    expect(response.body.errors?.[0]?.propertyName).toBe(propertyName);
    expect(mapWorldlineError(400, response.body).code).toBe("invalid_request");
    expect(fake.uniquePaymentCreations).toBe(0);
  }

  it("accepts a CreatePayment within every limit, so each rejection below comes from one property", async () => {
    const fake = new FakeWorldlineApi();
    expect((await postCreatePayment(fake, paymentBody())).status).toBe(201);
    expect(fake.uniquePaymentCreations).toBe(1);
  });

  it("rejects a CreatePayment without threeDSecure.redirectionData.returnUrl, even with the flat returnUrl", async () => {
    await expectRejection(
      paymentBody({ card: { threeDSecure: undefined } }),
      "cardPaymentMethodSpecificInput.threeDSecure.redirectionData.returnUrl",
    );
  });

  it("rejects a flat returnUrl over 200 characters or without a protocol, even beside a valid redirection one", async () => {
    for (const returnUrl of [urlOfLength(201), "shop.example/return", "/checkout/return"]) {
      await expectRejection(paymentBody({ card: { returnUrl } }), "cardPaymentMethodSpecificInput.returnUrl");
    }
    const fake = new FakeWorldlineApi();
    expect((await postCreatePayment(fake, paymentBody({ card: { returnUrl: urlOfLength(200) } }))).status).toBe(201);
  });

  it("rejects a softDescriptor over 256 characters and accepts one of exactly 256", async () => {
    await expectRejection(
      paymentBody({ order: { references: { softDescriptor: "d".repeat(257) } } }),
      "order.references.softDescriptor",
    );
    const fake = new FakeWorldlineApi();
    const atLimit = paymentBody({ order: { references: { softDescriptor: "d".repeat(256) } } });
    expect((await postCreatePayment(fake, atLimit)).status).toBe(201);
  });

  it("accepts every order.customer.device field at its contract limit, the ones the adapter never sends included", async () => {
    const device = {
      acceptHeader: "a".repeat(2048),
      ipAddress: "i".repeat(45),
      locale: "l".repeat(35),
      timezoneOffsetUtcMinutes: "-12345",
      userAgent: "u".repeat(2048),
      deviceFingerprint: "f".repeat(1024),
      browserData: { colorDepth: 99, javaEnabled: true, javaScriptEnabled: true, screenHeight: "999999", screenWidth: "999999" },
    };
    const fake = new FakeWorldlineApi();
    expect((await postCreatePayment(fake, paymentBody({ order: { customer: { device } } }))).status).toBe(201);
  });

  it("rejects an order.customer.device that is not an object", async () => {
    for (const device of ["fr-BE", ["fr-BE"], 42]) {
      await expectRejection(paymentBody({ order: { customer: { device } } }), "order.customer.device");
    }
  });

  const deviceRejections: Array<[string, unknown]> = [
    ["acceptHeader", "a".repeat(2049)],
    ["ipAddress", "i".repeat(46)],
    ["locale", "l".repeat(36)],
    ["locale", 35],
    ["timezoneOffsetUtcMinutes", -120],
    ["timezoneOffsetUtcMinutes", "-123456"],
    ["userAgent", "u".repeat(2049)],
    ["deviceFingerprint", "f".repeat(1025)],
    ["browserData", "24-bit"],
    ["browserData.colorDepth", 100],
    ["browserData.colorDepth", 24.5],
    ["browserData.colorDepth", "24"],
    ["browserData.javaEnabled", "false"],
    ["browserData.javaScriptEnabled", 1],
    ["browserData.screenHeight", 1080],
    ["browserData.screenWidth", "1234567"],
  ];
  for (const [field, value] of deviceRejections) {
    it(`rejects order.customer.device.${field} = ${describeValue(value)}, off the contract's types and limits`, async () => {
      const [parent, child] = field.split(".") as [string, string | undefined];
      const device = child ? { [parent]: { [child]: value } } : { [parent]: value };
      await expectRejection(paymentBody({ order: { customer: { device } } }), `order.customer.device.${field}`);
    });
  }

  it("accepts every transactionChannel and Cartes Bancaires use case the contract defines, and each Cartes Bancaires field at its limits", async () => {
    const useCases = [
      "single-amount",
      "fixed-amount-term-subscription",
      "payment-by-instalments",
      "payment-upon-shipment",
      "other-recurring-payments",
    ];
    const accepted: Array<Record<string, unknown>> = [
      { transactionChannel: "ECOMMERCE" },
      { transactionChannel: "MOTO" },
      ...useCases.map((usecase) => ({ paymentProduct130SpecificInput: { threeDSecure: { usecase } } })),
      ...[0, 99].map((numberOfItems) => ({
        paymentProduct130SpecificInput: { threeDSecure: { usecase: "single-amount", numberOfItems } },
      })),
      { paymentProduct130SpecificInput: { threeDSecure: { acquirerExemption: false, merchantScore: "m".repeat(20) } } },
      { paymentProduct130SpecificInput: {} },
    ];
    for (const card of accepted) {
      const fake = new FakeWorldlineApi();
      expect((await postCreatePayment(fake, paymentBody({ card }))).status, JSON.stringify(card)).toBe(201);
    }
  });

  for (const transactionChannel of ["moto", "MAIL_ORDER", "", 1, null]) {
    it(`rejects cardPaymentMethodSpecificInput.transactionChannel = ${describeValue(transactionChannel)}, outside the contract's enum`, async () => {
      await expectRejection(paymentBody({ card: { transactionChannel } }), "cardPaymentMethodSpecificInput.transactionChannel");
    });
  }

  it("rejects a Cartes Bancaires input, or its threeDSecure, that is not an object", async () => {
    for (const input of ["single-amount", ["single-amount"], null]) {
      await expectRejection(
        paymentBody({ card: { paymentProduct130SpecificInput: input } }),
        "cardPaymentMethodSpecificInput.paymentProduct130SpecificInput",
      );
    }
    for (const threeDSecure of ["single-amount", ["single-amount"], null]) {
      await expectRejection(
        paymentBody({ card: { paymentProduct130SpecificInput: { threeDSecure } } }),
        "cardPaymentMethodSpecificInput.paymentProduct130SpecificInput.threeDSecure",
      );
    }
  });

  const cartesBancairesRejections: Array<[string, unknown]> = [
    ["usecase", "SINGLE-AMOUNT"],
    ["usecase", "single_amount"],
    ["usecase", ""],
    ["usecase", "recurring"],
    ["usecase", 1],
    ["usecase", null],
    ["numberOfItems", -1],
    ["numberOfItems", 100],
    ["numberOfItems", 2.5],
    ["numberOfItems", "5"],
    ["numberOfItems", null],
    ["acquirerExemption", "false"],
    ["acquirerExemption", 0],
    ["merchantScore", "m".repeat(21)],
    ["merchantScore", 23],
  ];
  for (const [field, value] of cartesBancairesRejections) {
    it(`rejects paymentProduct130SpecificInput.threeDSecure.${field} = ${describeValue(value)}, off the contract's types, enum and limits`, async () => {
      const threeDSecure = { ...CARTES_BANCAIRES_INPUT.threeDSecure, [field]: value };
      await expectRejection(
        paymentBody({ card: { paymentProduct130SpecificInput: { threeDSecure } } }),
        `cardPaymentMethodSpecificInput.paymentProduct130SpecificInput.threeDSecure.${field}`,
      );
    });
  }

  it("rejects a merchantReference over 40 characters that a hand-minted context carries to it", async () => {
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
        id: "o".repeat(41),
      },
      SIGNING_KEY,
    );
    await expect(
      adapter.completePayment({ pspSessionId: context, clientToken: envelope("htp_1", DEVICE), idempotencyKey: "complete-long" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fake.uniquePaymentCreations).toBe(0);
  });
});

describe("the return URL follows Worldline's length and protocol rules", () => {
  const propertyName = "cardPaymentMethodSpecificInput.threeDSecure.redirectionData.returnUrl";

  function refusal(adapter: WorldlineServerAdapter, session: Partial<CreatePaymentSessionInput>) {
    return adapter
      .createPaymentSession({ amount: 1000, currency: "EUR", idempotencyKey: "k", ...session })
      .then(() => undefined, (err: unknown) => err as PayFanoutError);
  }

  it("refuses a return URL longer than 200 characters before any call to Worldline", async () => {
    const { adapter, fetchSpy } = makePair();
    const error = await refusal(adapter, { returnUrl: urlOfLength(201) });
    expect(error).toMatchObject({ code: "invalid_request", retryable: false });
    expect(error?.message).toMatch(/at most 200 characters, got 201/);
    expect(error?.raw).toEqual({ propertyName });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a return URL that does not start with scheme:// before any call to Worldline", async () => {
    for (const returnUrl of ["shop.example/return", "//shop.example/return", "/checkout/return", "https:/shop.example/return"]) {
      const { adapter, fetchSpy } = makePair();
      const error = await refusal(adapter, { returnUrl });
      expect(error).toMatchObject({ code: "invalid_request", retryable: false });
      expect(error?.message).toMatch(/protocol/);
      expect(error?.raw).toEqual({ propertyName });
      expect(fetchSpy).not.toHaveBeenCalled();
    }
  });

  it("accepts an https URL of exactly 200 characters and sends it in both forms", async () => {
    const returnUrl = urlOfLength(200);
    expect(returnUrl).toHaveLength(200);
    const { adapter, fake } = makePair();
    const info = await complete(adapter, { returnUrl });
    expect(info.status).toBe("succeeded");
    expect(createPaymentBody(fake).cardPaymentMethodSpecificInput).toMatchObject({
      returnUrl,
      threeDSecure: { redirectionData: { returnUrl } },
    });
  });

  it("accepts a custom app scheme", async () => {
    for (const returnUrl of ["myapp://checkout/return", "com.example.shop://checkout/return"]) {
      const { adapter, fake } = makePair();
      const info = await complete(adapter, { returnUrl });
      expect(info.status).toBe("succeeded");
      expect(createPaymentBody(fake).cardPaymentMethodSpecificInput).toMatchObject({
        returnUrl,
        threeDSecure: { redirectionData: { returnUrl } },
      });
    }
  });

  it("refuses a defaultReturnUrl that breaks either rule when the adapter is constructed", () => {
    for (const defaultReturnUrl of [urlOfLength(201), "shop.example/return"]) {
      let error: unknown;
      try {
        makePair({ defaultReturnUrl });
      } catch (err) {
        error = err;
      }
      expect(error).toMatchObject({ code: "invalid_request", retryable: false });
      expect((error as PayFanoutError).raw).toEqual({ propertyName });
    }
  });

  it("the fake rejects an over-long or scheme-less return URL that a hand-minted context carries to it", async () => {
    for (const returnUrl of [urlOfLength(201), "shop.example/return"]) {
      const { adapter, fake, fetchSpy } = makePair();
      const context = await encodeSessionContext(
        {
          v: 1,
          amount: 1000,
          currency: "EUR",
          captureMethod: "automatic",
          hostedTokenizationId: "htp_1",
          expiresAt: Date.now() + 60_000,
          returnUrl,
        },
        SIGNING_KEY,
      );
      const error = await adapter
        .completePayment({ pspSessionId: context, clientToken: envelope("htp_1", DEVICE), idempotencyKey: "complete-url" })
        .then(() => undefined, (err: unknown) => err as PayFanoutError);
      expect(error).toMatchObject({ code: "invalid_request", retryable: false });
      expect(error?.raw).toMatchObject({ errors: [{ propertyName }] });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fake.uniquePaymentCreations).toBe(0);
    }
  });
});
