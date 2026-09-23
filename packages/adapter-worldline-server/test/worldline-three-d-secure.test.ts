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

  it("drops every key outside Worldline's device contract, including a browser-claimed acceptHeader and ipAddress", () => {
    const sent = {
      ...DEVICE,
      acceptHeader: "text/html",
      ipAddress: "203.0.113.7",
      deviceFingerprint: "fp-1",
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
    });
  });

  const scaCases: Array<[CreatePaymentSessionInput["sca"], string | undefined]> = [
    [{ challenge: "force" }, "challenge-required"],
    [{ challenge: "force", exemption: "moto" }, "challenge-required"],
    [{ challenge: "automatic" }, undefined],
    [{ exemption: "moto" }, undefined],
    [undefined, undefined],
  ];
  for (const [sca, challengeIndicator] of scaCases) {
    it(`maps sca ${JSON.stringify(sca) ?? "absent"} to ${challengeIndicator ?? "no challengeIndicator"} and never an exemption`, async () => {
      const { adapter, fake } = makePair();
      await complete(adapter, sca ? { sca } : {});
      const threeDSecure = createPaymentBody(fake).cardPaymentMethodSpecificInput.threeDSecure;
      if (challengeIndicator) expect(threeDSecure).toHaveProperty("challengeIndicator", challengeIndicator);
      else expect(threeDSecure).not.toHaveProperty("challengeIndicator");
      // Worldline's exemptionRequest has no MOTO value, so the exemption is withheld.
      expect(threeDSecure).not.toHaveProperty("exemptionRequest");
    });
  }

  it("sends the statement descriptor as softDescriptor, never the deprecated descriptor", async () => {
    const { adapter, fake } = makePair();
    const info = await complete(adapter, { id: "order-77", statementDescriptor: "SHOP ORDER 77" });
    expect(info.id).toBe("order-77");
    expect(createPaymentBody(fake).order.references).toEqual({ merchantReference: "order-77", softDescriptor: "SHOP ORDER 77" });
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

describe("the fake is as strict as the documented platform", () => {
  const authorization = { authorization: "GCS v1HMAC:api-key-id:signature", "content-type": "application/json" };

  it("rejects a CreatePayment without threeDSecure.redirectionData.returnUrl, even with the flat returnUrl", async () => {
    const fake = new FakeWorldlineApi();
    const response = await fake.fetch(PAYMENTS_URL, {
      method: "POST",
      headers: authorization,
      body: JSON.stringify({
        order: { amountOfMoney: { amount: 1000, currencyCode: "EUR" } },
        hostedTokenizationId: "htp_1",
        cardPaymentMethodSpecificInput: { authorizationMode: "SALE", returnUrl: RETURN_URL },
      }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { errors: Array<{ propertyName?: string }> };
    expect(body.errors[0]?.propertyName).toBe("cardPaymentMethodSpecificInput.threeDSecure.redirectionData.returnUrl");
    expect(mapWorldlineError(400, body).code).toBe("invalid_request");
    expect(fake.uniquePaymentCreations).toBe(0);
  });

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

  function urlOfLength(length: number): string {
    const base = "https://host.example/return/";
    return base + "r".repeat(length - base.length);
  }

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

  it("refuses a defaultReturnUrl that breaks either rule the same way, and never checks one a session overrides", async () => {
    for (const defaultReturnUrl of [urlOfLength(201), "shop.example/return"]) {
      const { adapter, fetchSpy } = makePair({ defaultReturnUrl });
      const error = await refusal(adapter, {});
      expect(error).toMatchObject({ code: "invalid_request", retryable: false });
      expect(error?.raw).toEqual({ propertyName });
      expect(fetchSpy).not.toHaveBeenCalled();

      const overridden = makePair({ defaultReturnUrl });
      const info = await complete(overridden.adapter, { returnUrl: RETURN_URL });
      expect(info.status).toBe("succeeded");
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
