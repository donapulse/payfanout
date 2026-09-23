import { describe, expect, it } from "vitest";
import { isPayFanoutError, type CreatePaymentSessionInput } from "@payfanout/core";
import { AdyenServerAdapter, type AdyenServerAdapterConfig } from "../src/index.js";
import { FakeAdyenApi } from "./fake-adyen-api.js";

const HMAC_KEY = "44782DEF547AAA06C910C43932B1EB0C71FC68D9D0C057550C48EC2ACF6BA056";

function makePair(config: Partial<AdyenServerAdapterConfig> = {}): { adapter: AdyenServerAdapter; fake: FakeAdyenApi } {
  const fake = new FakeAdyenApi();
  const adapter = new AdyenServerAdapter({
    apiKey: "checkout-api-key",
    merchantAccount: "TestMerchant",
    environment: "sandbox",
    defaultReturnUrl: "https://shop.example/checkout/return",
    sessionSigningKey: "session-signing-key",
    hmacKeys: [HMAC_KEY],
    webhookBasicAuth: { username: "webhook-user", password: "webhook-password" },
    fetch: fake.fetch,
    sleep: async () => {},
    ...config,
  });
  return { adapter, fake };
}

/** An adapter whose every Adyen call answers `body`, for answers the fake never gives. */
function answering(body: Record<string, unknown>): AdyenServerAdapter {
  return makePair({
    fetch: async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
  }).adapter;
}

/** Documented sandbox test card, in the encrypted-credential form Adyen's test environment takes. */
const CARD = {
  type: "scheme",
  encryptedCardNumber: "test_4111111111111111",
  encryptedExpiryMonth: "test_03",
  encryptedExpiryYear: "test_2030",
  encryptedSecurityCode: "test_737",
  holderName: "J. Smith",
};
const CHALLENGED_CARD = { ...CARD, holderName: "CHALLENGE" };

/** What Adyen Web 6.41.0's collectBrowserInfo() reports. */
const BROWSER_INFO = {
  acceptHeader: "*/*",
  javaEnabled: false,
  colorDepth: 24,
  language: "nl-NL",
  screenHeight: 723,
  screenWidth: 1536,
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/70.0.3538.110 Safari/537.36",
  timeZoneOffset: 0,
};
const ORIGIN = "https://shop.example";
const BILLING_ADDRESS = {
  street: "Infinite Loop",
  houseNumberOrName: "1",
  postalCode: "1011DJ",
  city: "Amsterdam",
  country: "NL",
};

function envelope(extra: Record<string, unknown> = {}, paymentMethod: Record<string, unknown> = CARD): string {
  return JSON.stringify({ paymentMethod, browserInfo: BROWSER_INFO, origin: ORIGIN, ...extra });
}

async function session(adapter: AdyenServerAdapter, input: Partial<CreatePaymentSessionInput> = {}) {
  return adapter.createPaymentSession({ amount: 2500, currency: "EUR", idempotencyKey: "session-key", ...input });
}

function actionOf(raw: unknown): Record<string, unknown> {
  return (raw as { action: Record<string, unknown> }).action;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

describe("Adyen native 3-D Secure 2 request", () => {
  it("asks for native 3-D Secure 2 with the browser data confirm() sends, and nothing else from the browser", async () => {
    const { adapter, fake } = makePair();
    const created = await session(adapter, { receiptEmail: "shopper@example.test" });
    const info = await adapter.completePayment({
      pspSessionId: created.pspSessionId,
      clientToken: envelope(
        {
          browserInfo: { ...BROWSER_INFO, javaScriptEnabled: true, plugins: "none" },
          billingAddress: { ...BILLING_ADDRESS, stateOrProvince: "NH", apartment: "3" },
          riskData: { clientData: "eyJ2ZXJzaW9uIjoiMS4wLjAifQ==", fraudOffset: -100, profileReference: "lenient" },
          // None of these may come from the browser: the signed session owns them.
          amount: { currency: "EUR", value: 1 },
          reference: "another-order",
          merchantAccount: "AnotherMerchant",
          additionalData: { manualCapture: "true" },
          installments: { value: 3 },
          storePaymentMethod: true,
          clientStateDataIndicator: true,
        },
        CHALLENGED_CARD,
      ),
      idempotencyKey: "complete-1",
    });
    expect(fake.lastPaymentBody).toEqual({
      merchantAccount: "TestMerchant",
      amount: { currency: "EUR", value: 2500 },
      reference: created.id,
      paymentMethod: CHALLENGED_CARD,
      returnUrl: "https://shop.example/checkout/return",
      shopperEmail: "shopper@example.test",
      browserInfo: { ...BROWSER_INFO, javaScriptEnabled: true },
      channel: "Web",
      origin: ORIGIN,
      authenticationData: { threeDSRequestData: { nativeThreeDS: "preferred" } },
      billingAddress: { ...BILLING_ADDRESS, stateOrProvince: "NH" },
      // fraudOffset would move the payment's fraud score: the merchant's lever, never the browser's.
      riskData: { clientData: "eyJ2ZXJzaW9uIjoiMS4wLjAifQ==" },
    });
    expect(fake.lastPaymentBody).not.toHaveProperty("shopperIP");
    expect(info.status).toBe("requires_action");
    expect(actionOf(info.raw)).toMatchObject({ type: "threeDS2", subtype: "fingerprint" });
  });

  it("reports an action Adyen answers without a pspReference, with no reference a modification would take", async () => {
    const { adapter, fake } = makePair();
    const created = await session(adapter, { captureMethod: "manual" });
    const info = await adapter.completePayment({
      pspSessionId: created.pspSessionId,
      clientToken: envelope({}, CHALLENGED_CARD),
      idempotencyKey: "complete-1",
    });
    expect(info).toMatchObject({ status: "requires_action", pspPaymentId: "", amount: 2500, currency: "EUR" });
    expect(info.amountCapturable).toBeUndefined();
    expect((info.raw as { pspReference?: string }).pspReference).toBeUndefined();
    const sent = fake.lastRequestPath;
    await expect(adapter.capturePayment(info.pspPaymentId, 2500, "capture-1")).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(adapter.refundPayment({ pspPaymentId: info.pspPaymentId, idempotencyKey: "refund-1" })).rejects.toMatchObject(
      { code: "invalid_request" },
    );
    expect(fake.lastRequestPath).toBe(sent);
  });

  it("keeps the body earlier client adapters get for a bare paymentMethod token", async () => {
    const { adapter, fake } = makePair();
    const created = await session(adapter);
    const info = await adapter.completePayment({
      pspSessionId: created.pspSessionId,
      clientToken: JSON.stringify(CARD),
      idempotencyKey: "complete-1",
    });
    expect(info.status).toBe("succeeded");
    expect(fake.lastPaymentBody).toEqual({
      merchantAccount: "TestMerchant",
      amount: { currency: "EUR", value: 2500 },
      reference: created.id,
      paymentMethod: CARD,
      returnUrl: "https://shop.example/checkout/return",
    });
  });

  it("accepts the origins a browser reports, ports included", async () => {
    for (const origin of ["https://shop.example:8443", "http://localhost:3000", "http://[::1]:5173"]) {
      const { adapter, fake } = makePair();
      const created = await session(adapter);
      await adapter.completePayment({
        pspSessionId: created.pspSessionId,
        clientToken: envelope({ origin }),
        idempotencyKey: "complete-1",
      });
      expect(fake.lastPaymentBody, origin).toMatchObject({ channel: "Web", origin });
    }
  });

  it("leaves the flow to Adyen's redirect when the origin is not the page's bare origin", async () => {
    const origins: unknown[] = [
      "https://shop.example/",
      "https://shop.example/checkout",
      "https://shop.example?x=1",
      "https://SHOP.example",
      "https://shop.example:443",
      "https://user@shop.example",
      "https://[::1",
      "null",
      "ftp://shop.example",
      `https://${"a".repeat(70)}.example`,
      42,
    ];
    for (const origin of origins) {
      const { adapter, fake } = makePair();
      const created = await session(adapter);
      const info = await adapter.completePayment({
        pspSessionId: created.pspSessionId,
        clientToken: envelope({ origin }, CHALLENGED_CARD),
        idempotencyKey: "complete-1",
      });
      const label = String(origin);
      expect(fake.lastPaymentBody, label).toMatchObject({ browserInfo: BROWSER_INFO });
      for (const field of ["origin", "channel", "authenticationData"]) {
        expect(fake.lastPaymentBody, label).not.toHaveProperty(field);
      }
      expect(actionOf(info.raw).type, label).toBe("redirect");
    }
  });

  it("drops browser data that is not the object Adyen documents", async () => {
    const { userAgent: _userAgent, ...withoutUserAgent } = BROWSER_INFO;
    const cases: Array<Record<string, unknown>> = [
      { browserInfo: withoutUserAgent },
      { browserInfo: { ...BROWSER_INFO, colorDepth: "24" } },
      { browserInfo: { ...BROWSER_INFO, javaEnabled: "false" } },
      { browserInfo: [BROWSER_INFO] },
      { browserInfo: "Mozilla/5.0" },
    ];
    for (const extra of cases) {
      const { adapter, fake } = makePair();
      const created = await session(adapter);
      await adapter.completePayment({
        pspSessionId: created.pspSessionId,
        clientToken: envelope({
          ...extra,
          billingAddress: { city: 42, country: "" },
          riskData: { clientData: "x".repeat(5001) },
        }),
        idempotencyKey: "complete-1",
      });
      for (const field of ["browserInfo", "origin", "channel", "authenticationData", "billingAddress", "riskData"]) {
        expect(fake.lastPaymentBody, JSON.stringify(extra)).not.toHaveProperty(field);
      }
    }
  });

  it("refuses a card token carrying unencrypted card fields without repeating it", async () => {
    // Adyen's documented sandbox card, as raw fields: exactly what must never pass through.
    const rawFields: Record<string, string> = {
      number: "4111111111111111",
      expiryMonth: "03",
      expiryYear: "2030",
      cvc: "737",
    };
    for (const [field, value] of Object.entries(rawFields)) {
      for (const clientToken of [envelope({}, { ...CARD, [field]: value }), JSON.stringify({ ...CARD, [field]: value })]) {
        const { adapter, fake } = makePair();
        const created = await session(adapter);
        const err = await rejection(
          adapter.completePayment({ pspSessionId: created.pspSessionId, clientToken, idempotencyKey: "complete-1" }),
        );
        expect(isPayFanoutError(err)).toBe(true);
        if (!isPayFanoutError(err)) continue;
        expect(err.code).toBe("invalid_request");
        expect(err.retryable).toBe(false);
        expect(err.raw).toEqual({ reason: "unencrypted card fields", fields: [field] });
        for (const text of [err.message, JSON.stringify(err.raw)]) {
          expect(text).not.toContain(value);
          expect(text).not.toContain("test_4111111111111111");
        }
        expect(fake.lastRequestPath).toBeUndefined();
      }
    }
  });

  it("refuses a paymentMethod that is not a card", async () => {
    const tokens = [
      envelope({}, { type: "ideal", issuer: "1121" }),
      JSON.stringify({ paymentMethod: "scheme" }),
      JSON.stringify({ paymentMethod: [CARD] }),
      JSON.stringify({ type: "ideal", issuer: "1121" }),
    ];
    for (const clientToken of tokens) {
      const { adapter, fake } = makePair();
      const created = await session(adapter);
      await expect(
        adapter.completePayment({ pspSessionId: created.pspSessionId, clientToken, idempotencyKey: "complete-1" }),
      ).rejects.toMatchObject({ code: "invalid_request", raw: { reason: "paymentMethod is not a card" } });
      expect(fake.lastRequestPath).toBeUndefined();
    }
  });

  it("keeps the clientToken out of every error that refuses it", async () => {
    const tokens: Array<[string, string]> = [
      ['{"number":"4111111111111111"', "4111111111111111"],
      ['["4111111111111111"]', "4111111111111111"],
      ['{"holderName":"J. Smith"}', "J. Smith"],
      [JSON.stringify({ details: { threeDSResult: "eyJ0cmFuc1N0YXR1cyI6IlkifQ==" }, paymentMethod: CARD }), "eyJ0"],
      [JSON.stringify({ details: "eyJ0cmFuc1N0YXR1cyI6IlkifQ==" }), "eyJ0"],
    ];
    for (const [clientToken, secret] of tokens) {
      const { adapter } = makePair();
      const created = await session(adapter);
      const err = await rejection(
        adapter.completePayment({ pspSessionId: created.pspSessionId, clientToken, idempotencyKey: "complete-1" }),
      );
      expect(isPayFanoutError(err), clientToken).toBe(true);
      if (!isPayFanoutError(err)) continue;
      expect(err.code, clientToken).toBe("invalid_request");
      expect(err.raw, clientToken).toBeDefined();
      expect(`${err.message} ${JSON.stringify(err.raw)}`, clientToken).not.toContain(secret);
    }
  });
});

describe("Adyen 3-D Secure completion", () => {
  it("finishes a native challenge with the details the action produced", async () => {
    const { adapter, fake } = makePair();
    const created = await session(adapter);
    const challenged = await adapter.completePayment({
      pspSessionId: created.pspSessionId,
      clientToken: envelope({}, CHALLENGED_CARD),
      idempotencyKey: "complete-1",
    });
    const details = fake.detailsFor(actionOf(challenged.raw));
    const finished = await adapter.completePayment({
      pspSessionId: created.pspSessionId,
      clientToken: JSON.stringify({ details }),
      idempotencyKey: "complete-2",
    });
    expect(fake.lastRequestPath).toMatch(/\/payments\/details$/);
    expect(fake.lastRequestBody).toEqual({ details });
    expect(finished.status).toBe("succeeded");
    // The pspReference arrived with the /payments/details answer, and it is a real one.
    expect(finished.pspPaymentId).toMatch(/^\d{16}:2500:EUR$/);
    await expect(adapter.refundPayment({ pspPaymentId: finished.pspPaymentId, idempotencyKey: "refund-1" })).resolves.toMatchObject({
      status: "pending",
      amount: 2500,
    });
  });

  it("reports a manual-capture authorisation from /payments/details as capturable", async () => {
    const { adapter, fake } = makePair();
    const created = await session(adapter, { captureMethod: "manual" });
    const challenged = await adapter.completePayment({
      pspSessionId: created.pspSessionId,
      clientToken: envelope({}, CHALLENGED_CARD),
      idempotencyKey: "complete-1",
    });
    const finished = await adapter.completePayment({
      pspSessionId: created.pspSessionId,
      clientToken: JSON.stringify({ details: fake.detailsFor(actionOf(challenged.raw)) }),
      idempotencyKey: "complete-2",
    });
    expect(fake.lastPaymentBody).toMatchObject({ additionalData: { manualCapture: "true" } });
    expect(finished).toMatchObject({ status: "requires_capture", amountCapturable: 2500 });
  });

  it("answers requires_action again when /payments/details asks for a challenge after the fingerprint", async () => {
    const { adapter, fake } = makePair();
    fake.challengesAfterIdentify = 1;
    const created = await session(adapter);
    const identified = await adapter.completePayment({
      pspSessionId: created.pspSessionId,
      clientToken: envelope({}, CHALLENGED_CARD),
      idempotencyKey: "complete-1",
    });
    const challenged = await adapter.completePayment({
      pspSessionId: created.pspSessionId,
      clientToken: JSON.stringify({ details: fake.detailsFor(actionOf(identified.raw)) }),
      idempotencyKey: "complete-2",
    });
    expect(challenged).toMatchObject({ status: "requires_action", pspPaymentId: "" });
    expect(actionOf(challenged.raw)).toMatchObject({ type: "threeDS2", subtype: "challenge" });
    const finished = await adapter.completePayment({
      pspSessionId: created.pspSessionId,
      clientToken: JSON.stringify({ details: fake.detailsFor(actionOf(challenged.raw)) }),
      idempotencyKey: "complete-3",
    });
    expect(finished.status).toBe("succeeded");
  });

  it("reads processing, not succeeded, when the details answer does not name the payment", async () => {
    const { adapter, fake } = makePair();
    fake.omitDetailsPaymentFacts = true;
    const created = await session(adapter);
    const challenged = await adapter.completePayment({
      pspSessionId: created.pspSessionId,
      clientToken: envelope({}, CHALLENGED_CARD),
      idempotencyKey: "complete-1",
    });
    const finished = await adapter.completePayment({
      pspSessionId: created.pspSessionId,
      clientToken: JSON.stringify({ details: fake.detailsFor(actionOf(challenged.raw)) }),
      idempotencyKey: "complete-2",
    });
    expect(finished.status).toBe("processing");
    expect(finished.pspPaymentId).toMatch(/^\d{16}:2500:EUR$/);

    // Half of the facts is not enough either.
    const answers: Array<Record<string, unknown>> = [
      { pspReference: "8836100000000042", resultCode: "Authorised", merchantReference: created.id },
      { pspReference: "8836100000000042", resultCode: "Authorised", amount: { value: 2500, currency: "EUR" } },
      { pspReference: "8836100000000042", resultCode: "Authorised", merchantReference: created.id, amount: { value: 2500 } },
    ];
    for (const answer of answers) {
      const info = await answering(answer).completePayment({
        pspSessionId: created.pspSessionId,
        clientToken: JSON.stringify({ details: { threeDSResult: "eyJ0cmFuc1N0YXR1cyI6IlkifQ==" } }),
        idempotencyKey: "complete-2",
      });
      expect(info.status, JSON.stringify(answer)).toBe("processing");
    }
  });

  it("refuses details that belong to another payment", async () => {
    const others: Array<Partial<{ reference: string; value: number; currency: string }>> = [
      { reference: "another-order", value: 2500, currency: "EUR" },
      { value: 100, currency: "EUR" },
      { value: 2500, currency: "USD" },
    ];
    for (const other of others) {
      const { adapter, fake } = makePair();
      const created = await session(adapter);
      await adapter.completePayment({
        pspSessionId: created.pspSessionId,
        clientToken: envelope({}, CHALLENGED_CARD),
        idempotencyKey: "complete-1",
      });
      const foreign = fake.seedChallengedPayment({ reference: created.id, ...other });
      const err = await rejection(
        adapter.completePayment({
          pspSessionId: created.pspSessionId,
          clientToken: JSON.stringify({ details: fake.detailsFor(foreign) }),
          idempotencyKey: "complete-2",
        }),
      );
      expect(isPayFanoutError(err), JSON.stringify(other)).toBe(true);
      if (!isPayFanoutError(err)) continue;
      expect(err).toMatchObject({ code: "invalid_request", retryable: false, pspName: "adyen" });
      expect(err.raw).toMatchObject({ resultCode: "Authorised" });
    }
  });

  it("refuses an action answer that belongs to another payment", async () => {
    const { adapter } = makePair();
    const created = await session(adapter);
    await expect(
      answering({
        resultCode: "ChallengeShopper",
        action: { type: "threeDS2", subtype: "challenge", token: "token", authorisationToken: "token" },
        merchantReference: "another-order",
      }).completePayment({
        pspSessionId: created.pspSessionId,
        clientToken: JSON.stringify({ details: { threeDSResult: "eyJ0cmFuc1N0YXR1cyI6IlkifQ==" } }),
        idempotencyKey: "complete-2",
      }),
    ).rejects.toMatchObject({ code: "invalid_request", retryable: false });
  });

  it("raises a refusal before checking whose payment it was", async () => {
    const { adapter, fake } = makePair();
    fake.refuseDetailsWith = "11";
    const created = await session(adapter);
    const foreign = fake.seedChallengedPayment({ reference: "another-order", value: 100 });
    await expect(
      adapter.completePayment({
        pspSessionId: created.pspSessionId,
        clientToken: JSON.stringify({ details: fake.detailsFor(foreign) }),
        idempotencyKey: "complete-2",
      }),
    ).rejects.toMatchObject({ code: "authentication_required", retryable: false });
  });

  it("completes a redirect return with the redirectResult the shopper came back with", async () => {
    const { adapter, fake } = makePair();
    const created = await session(adapter);
    const redirected = await adapter.completePayment({
      pspSessionId: created.pspSessionId,
      clientToken: JSON.stringify(CHALLENGED_CARD),
      idempotencyKey: "complete-1",
    });
    const action = actionOf(redirected.raw);
    expect(action).toMatchObject({ type: "redirect", method: "GET" });
    const { redirectResult } = fake.detailsFor(action);
    const finished = await adapter.completePayment({
      pspSessionId: created.pspSessionId,
      clientToken: JSON.stringify({ details: { redirectResult } }),
      idempotencyKey: "complete-2",
    });
    expect(fake.lastRequestBody).toEqual({ details: { redirectResult } });
    expect(finished.status).toBe("succeeded");
  });

  it("holds a redirect return to the signed session's expiry", async () => {
    let clock = Date.parse("2026-09-23T10:00:00Z");
    const { adapter, fake } = makePair({ now: () => clock });
    const created = await session(adapter);
    const redirected = await adapter.completePayment({
      pspSessionId: created.pspSessionId,
      clientToken: JSON.stringify(CHALLENGED_CARD),
      idempotencyKey: "complete-1",
    });
    clock += 3600 * 1000 + 1;
    await expect(
      adapter.completePayment({
        pspSessionId: created.pspSessionId,
        clientToken: JSON.stringify({ details: fake.detailsFor(actionOf(redirected.raw)) }),
        idempotencyKey: "complete-2",
      }),
    ).rejects.toMatchObject({ code: "session_expired" });
    expect(fake.lastRequestPath).toMatch(/\/payments$/);
  });
});

describe("Adyen session inputs 3-D Secure depends on", () => {
  it("refuses a returnUrl Adyen would reject, and accepts web and app URLs", async () => {
    const { adapter } = makePair();
    const refused = [
      `https://shop.example/${"a".repeat(1004)}`,
      "shop.example/checkout/return",
      "/checkout/return",
      "https://shop.example//return",
      "https://shop.example/checkout//return",
      "https://",
      "https://[bad/return",
      "https://shop.example/check out",
    ];
    for (const returnUrl of refused) {
      await expect(session(adapter, { returnUrl }), returnUrl).rejects.toMatchObject({
        code: "invalid_request",
        raw: { field: "returnUrl" },
      });
    }
    const accepted = [
      `https://shop.example/${"a".repeat(1003)}`,
      "https://shop.example/checkout?shopperOrder=12xy",
      "my-app://",
      "adyencheckout://com.example.shop",
    ];
    for (const returnUrl of accepted) {
      await expect(session(adapter, { returnUrl }), returnUrl).resolves.toMatchObject({ status: "requires_payment_method" });
    }
  });

  it("refuses a malformed defaultReturnUrl when the adapter is constructed", () => {
    for (const defaultReturnUrl of ["shop.example/return", "https://shop.example//return", `https://shop.example/${"a".repeat(1004)}`]) {
      let thrown: unknown;
      try {
        makePair({ defaultReturnUrl });
      } catch (err) {
        thrown = err;
      }
      expect(thrown, defaultReturnUrl).toMatchObject({ code: "invalid_request", raw: { field: "defaultReturnUrl" } });
    }
  });

  it("treats an empty defaultReturnUrl as none", async () => {
    const { adapter } = makePair({ defaultReturnUrl: "" });
    await expect(session(adapter)).rejects.toMatchObject({ code: "invalid_request", message: /returnUrl/ });
  });

  it("sends shopperEmail from receiptEmail, else from billingDetails.email", async () => {
    const cases: Array<[Partial<CreatePaymentSessionInput>, string | undefined]> = [
      [{ receiptEmail: "receipt@example.test", billingDetails: { email: "billing@example.test" } }, "receipt@example.test"],
      [{ billingDetails: { email: "billing@example.test" } }, "billing@example.test"],
      [{ receiptEmail: "", billingDetails: { email: "billing@example.test" } }, "billing@example.test"],
      // Not the address Adyen gets, so not checked.
      [{ receiptEmail: "receipt@example.test", billingDetails: { email: "not an address" } }, "receipt@example.test"],
      [{}, undefined],
    ];
    for (const [input, expected] of cases) {
      const { adapter, fake } = makePair();
      const created = await session(adapter, input);
      await adapter.completePayment({ pspSessionId: created.pspSessionId, clientToken: envelope(), idempotencyKey: "complete-1" });
      if (expected) expect(fake.lastPaymentBody).toMatchObject({ shopperEmail: expected });
      else expect(fake.lastPaymentBody).not.toHaveProperty("shopperEmail");
    }
  });

  it("refuses a shopper email Adyen could not use", async () => {
    const { adapter } = makePair();
    const malformed = ["not-an-email", "shopper@localhost", "shop per@example.test", "@example.test", `${"a".repeat(245)}@example.test`];
    for (const email of malformed) {
      await expect(session(adapter, { receiptEmail: email }), email).rejects.toMatchObject({
        code: "invalid_request",
        raw: { field: "receiptEmail" },
      });
      await expect(session(adapter, { billingDetails: { email } }), email).rejects.toMatchObject({
        code: "invalid_request",
        raw: { field: "billingDetails.email" },
      });
    }
    await expect(session(adapter, { receiptEmail: `${"a".repeat(243)}@example.test` })).resolves.toBeDefined();
  });
});
