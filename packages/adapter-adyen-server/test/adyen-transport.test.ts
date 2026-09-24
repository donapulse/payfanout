import { describe, expect, it } from "vitest";
import { isPayFanoutError, sha256Hex } from "@payfanout/core";
import {
  AdyenServerAdapter,
  deriveAdyenIdempotencyKey,
  mapAdyenError,
  mapAdyenRefusal,
  type AdyenServerAdapterConfig,
} from "../src/index.js";
import { derivePaymentIdempotencyKey } from "../src/signing.js";
import { FakeAdyenApi } from "./fake-adyen-api.js";

/** Adyen's published webhook HMAC test key; nothing here verifies a webhook. */
const HMAC_KEY = "44782DEF547AAA06C910C43932B1EB0C71FC68D9D0C057550C48EC2ACF6BA056";

/** Documented sandbox test card, encrypted-credential form for server-side tests. */
const CLIENT_TOKEN = JSON.stringify({
  type: "scheme",
  encryptedCardNumber: "test_4111111111111111",
  encryptedExpiryMonth: "test_03",
  encryptedExpiryYear: "test_2030",
  encryptedSecurityCode: "test_737",
});

/** What Adyen Web 6.41.0's collectBrowserInfo() reports: every member the web flow requires. */
const NATIVE_BROWSER_INFO = {
  acceptHeader: "*/*",
  javaEnabled: false,
  colorDepth: 24,
  language: "nl-NL",
  screenHeight: 723,
  screenWidth: 1536,
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/70.0.3538.110 Safari/537.36",
  timeZoneOffset: 0,
};

/** A composite reference for a payment the fake has never seen. */
const UNKNOWN_PAYMENT = "8836100000000042:1000:EUR";

/** The generic error examples of the Checkout v72 API contract. */
const GENERIC_401 = {
  status: 401,
  errorCode: "000",
  message: "HTTP Status Response - Unauthorized",
  errorType: "security",
};
const GENERIC_422 = { status: 422, errorCode: "14_030", message: "Return URL is missing.", errorType: "validation" };
const GENERIC_500 = {
  status: 500,
  errorCode: "905",
  message: "Payment details are not supported",
  errorType: "configuration",
};

function makeAdapter(overrides: Partial<AdyenServerAdapterConfig> = {}): AdyenServerAdapter {
  return new AdyenServerAdapter({
    apiKey: "checkout-api-key",
    merchantAccount: "TestMerchant",
    environment: "sandbox",
    defaultReturnUrl: "https://host.example/return",
    sessionSigningKey: "session-signing-key",
    hmacKeys: [HMAC_KEY],
    webhookBasicAuth: { username: "webhook-user", password: "webhook-password" },
    sleep: async () => {},
    ...overrides,
  });
}

function withFake(overrides: Partial<AdyenServerAdapterConfig> = {}): { adapter: AdyenServerAdapter; fake: FakeAdyenApi } {
  const fake = new FakeAdyenApi();
  return { adapter: makeAdapter({ fetch: fake.fetch, ...overrides }), fake };
}

/** An adapter every call of which is answered with `status` and `body`, counting the calls. */
function answering(status: number, body: string): { adapter: AdyenServerAdapter; calls: () => number } {
  let calls = 0;
  const adapter = makeAdapter({
    fetch: async () => {
      calls++;
      return new Response(body, { status, headers: { "content-type": "application/json" } });
    },
  });
  return { adapter, calls: () => calls };
}

async function pay(adapter: AdyenServerAdapter, idempotencyKey: string, captureMethod?: "manual") {
  const session = await adapter.createPaymentSession({
    amount: 2500,
    currency: "EUR",
    ...(captureMethod ? { captureMethod } : {}),
    idempotencyKey: `${idempotencyKey}-session`,
  });
  return adapter.completePayment({ pspSessionId: session.pspSessionId, clientToken: CLIENT_TOKEN, idempotencyKey });
}

/** Resolves the rejection as a PayFanoutError, or fails the test. */
async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    if (isPayFanoutError(err)) return err;
    throw err;
  }
  return expect.unreachable("expected a rejection");
}

describe("the idempotency-key derivations", () => {
  const base = { merchantAccount: "TestMerchant", path: "/payments", idempotencyKey: "caller-key" } as const;

  it("keeps the header 0.1.0 sent on every capture, cancel and refund", async () => {
    const path = "/payments/8836100000000001/refunds";
    // Pinned as a literal (SHA-256 of "/payments/8836100000000001/refunds\ncaller-key"),
    // so a change in the hashing helper cannot move the 0.1.0 value unnoticed.
    expect(await deriveAdyenIdempotencyKey(path, "caller-key")).toBe(
      "ae39e1438b98b9fb8c52ee7c1c4d12d31c29784446628c69d4eb249eedb00296",
    );

    const { adapter, fake } = withFake();
    const captured = await pay(adapter, "complete-1", "manual");
    await adapter.capturePayment(captured.pspPaymentId, 1000, "capture-key");
    await adapter.refundPayment({ pspPaymentId: captured.pspPaymentId, amount: 500, idempotencyKey: "refund-key" });
    const canceled = await pay(adapter, "complete-2", "manual");
    await adapter.cancelPayment(canceled.pspPaymentId, "cancel-key");

    const keys = ["capture-key", "refund-key", "cancel-key"];
    const modifications = fake.requests.filter((request) => /\/(captures|refunds|cancels)$/.test(request.path));
    expect(modifications).toHaveLength(keys.length);
    for (const [index, request] of modifications.entries()) {
      // The fake records the versioned path; the header covers it without the version.
      const unversioned = request.path.replace(/^\/v72/, "");
      expect(request.idempotencyKey).toBe(await sha256Hex(`${unversioned}\n${keys[index]}`));
    }
  });

  it("scopes /payments and /payments/details to the merchant account and moves both off the 0.1.0 value", async () => {
    const header = await derivePaymentIdempotencyKey(base);
    expect(header).toMatch(/^[0-9a-f]{64}$/);
    for (const other of [
      { ...base, merchantAccount: "TestMerchantUS" },
      { ...base, path: "/payments/details" as const },
      { ...base, idempotencyKey: "caller-key-2" },
    ]) {
      expect(await derivePaymentIdempotencyKey(other)).not.toBe(header);
    }
    // Nothing submitted alongside a /payments request reaches its header.
    expect(await derivePaymentIdempotencyKey({ ...base, details: { threeDSResult: "one" }, paymentData: "Ab02" })).toBe(
      header,
    );
    // The reason completions first sent by 0.1.0 must not be retried after the upgrade.
    expect(header).not.toBe(await sha256Hex("/payments\ncaller-key"));
    const details = await derivePaymentIdempotencyKey({ ...base, path: "/payments/details", details: {} });
    expect(details).not.toBe(await sha256Hex("/payments/details\ncaller-key"));
  });

  it("encodes its fields unambiguously", async () => {
    // Joined with a newline, these two would hash the same text.
    const first = await derivePaymentIdempotencyKey({ ...base, merchantAccount: "M\n/payments", idempotencyKey: "x" });
    const second = await derivePaymentIdempotencyKey({ ...base, merchantAccount: "M", idempotencyKey: "/payments\nx" });
    expect(first).not.toBe(second);
  });

  it("covers the /payments/details submission as canonical JSON data", async () => {
    const scope = { ...base, path: "/payments/details" } as const;
    const derive = (submission: { details?: unknown; paymentData?: string }) =>
      derivePaymentIdempotencyKey({ ...scope, ...submission });
    const step = await derive({ details: { threeDSResult: "one" }, paymentData: "Ab02" });
    expect(await derive({ details: { threeDSResult: "one" }, paymentData: "Ab02" })).toBe(step);
    expect(await derive({ details: { threeDSResult: "two" }, paymentData: "Ab02" })).not.toBe(step);
    expect(await derive({ details: { threeDSResult: "one" }, paymentData: "Cd03" })).not.toBe(step);
    expect(await derive({ details: { threeDSResult: "one" } })).not.toBe(step);

    // Key order is not content, array order is.
    const nested = { a: 1, b: { d: [1, { f: true, e: null }], c: "x" } };
    const reordered = { b: { c: "x", d: [1, { e: null, f: true }] }, a: 1 };
    expect(await derive({ details: nested })).toBe(await derive({ details: reordered }));
    expect(await derive({ details: { list: [1, 2] } })).not.toBe(await derive({ details: { list: [2, 1] } }));
    // null is data; what JSON.stringify drops is not: such a member is left
    // out, and such an array item written as null.
    expect(await derive({ details: { a: null } })).not.toBe(await derive({ details: {} }));
    for (const dropped of [undefined, () => 1, Symbol("dropped")]) {
      expect(await derive({ details: { a: 1, b: dropped } })).toBe(await derive({ details: { a: 1 } }));
      expect(await derive({ details: { list: [dropped, 1] } })).toBe(await derive({ details: { list: [null, 1] } }));
    }
    const holey: unknown[] = new Array(2);
    holey[1] = 1;
    expect(await derive({ details: { list: holey } })).toBe(await derive({ details: { list: [null, 1] } }));
  });
});

describe("idempotency across one company account", () => {
  it("creates one payment per merchant account when two share a caller key", async () => {
    // One fake = one company account, and Adyen checks keys across all of it.
    const fake = new FakeAdyenApi();
    const europe = makeAdapter({ merchantAccount: "ShopEU", fetch: fake.fetch });
    const america = makeAdapter({ merchantAccount: "ShopUS", fetch: fake.fetch });
    const first = await pay(europe, "order-1-complete");
    const second = await pay(america, "order-1-complete");

    expect(fake.uniquePaymentCreations).toBe(2);
    expect(fake.replays).toBe(0);
    expect(second.pspPaymentId).not.toBe(first.pspPaymentId);
    const payments = fake.requests.filter((request) => request.path.endsWith("/payments"));
    expect(payments.map((request) => request.body?.["merchantAccount"])).toEqual(["ShopEU", "ShopUS"]);
    expect(new Set(payments.map((request) => request.idempotencyKey)).size).toBe(2);
  });

  it("answers a replay of the same call from Adyen's store, performing it once", async () => {
    const { adapter, fake } = withFake();
    const session = await adapter.createPaymentSession({ amount: 2500, currency: "EUR", idempotencyKey: "s" });
    const input = { pspSessionId: session.pspSessionId, clientToken: CLIENT_TOKEN, idempotencyKey: "complete-1" };
    const first = await adapter.completePayment(input);
    expect(await adapter.completePayment(input)).toEqual(first);
    expect(fake.uniquePaymentCreations).toBe(1);

    const refund = { pspPaymentId: first.pspPaymentId, amount: 1000, idempotencyKey: "refund-1" };
    const refunded = await adapter.refundPayment(refund);
    expect(await adapter.refundPayment(refund)).toEqual(refunded);
    expect(fake.uniqueRefundRequests).toBe(1);
    expect(fake.replays).toBe(2);
  });

  it("keeps the /payments body out of the header, so a completion retried with a changed blob is one payment", async () => {
    const { adapter, fake } = withFake();
    const session = await adapter.createPaymentSession({ amount: 2500, currency: "EUR", idempotencyKey: "s" });
    const complete = (holderName: string) =>
      adapter.completePayment({
        pspSessionId: session.pspSessionId,
        clientToken: JSON.stringify({ ...JSON.parse(CLIENT_TOKEN), holderName }),
        idempotencyKey: "complete-1",
      });
    const first = await complete("J. Smith");
    // A free-text field of the paymentMethod blob changed before the retry.
    expect(await complete("John Smith")).toEqual(first);
    expect(fake.uniquePaymentCreations).toBe(1);
    expect(fake.replays).toBe(1);
    const payments = fake.requests.filter((request) => request.path.endsWith("/payments"));
    expect(payments.map((request) => (request.body?.["paymentMethod"] as { holderName?: string }).holderName)).toEqual([
      "J. Smith",
      "John Smith",
    ]);
    expect(payments[1]!.idempotencyKey).toBe(payments[0]!.idempotencyKey);
  });

  it("sends each /payments/details step as its own request, and a repeated step once", async () => {
    const { adapter, fake } = withFake();
    // Native 3-D Secure: IdentifyShopper, one ChallengeShopper, then the result.
    fake.challengesAfterIdentify = 1;
    const session = await adapter.createPaymentSession({ amount: 3200, currency: "EUR", idempotencyKey: "s" });
    // Every step of the flow goes through one completion handler, one caller key.
    const complete = (clientToken: string) =>
      adapter.completePayment({ pspSessionId: session.pspSessionId, clientToken, idempotencyKey: "one-caller-key" });
    const actionOf = (info: { raw?: unknown }) => (info.raw as { action: Record<string, unknown> }).action;

    const identify = await complete(
      JSON.stringify({
        paymentMethod: { ...JSON.parse(CLIENT_TOKEN), holderName: "CHALLENGE" },
        browserInfo: NATIVE_BROWSER_INFO,
        origin: "https://shop.example",
      }),
    );
    expect(identify.status).toBe("requires_action");
    const challenge = await complete(JSON.stringify({ details: fake.detailsFor(actionOf(identify)) }));
    expect(challenge.status).toBe("requires_action");
    const lastStep = JSON.stringify({ details: fake.detailsFor(actionOf(challenge)) });
    const result = await complete(lastStep);
    expect(fake.replays).toBe(0);
    expect(await complete(lastStep)).toEqual(result);
    expect(fake.replays).toBe(1);

    const detailsKeys = fake.requests
      .filter((request) => request.path.endsWith("/payments/details"))
      .map((request) => request.idempotencyKey);
    expect(detailsKeys).toHaveLength(3);
    expect(new Set(detailsKeys).size).toBe(2);
  });
});

describe("modification acknowledgements", () => {
  it("resolves a capture, cancel or refund on a reference the fake does not know", async () => {
    // Adyen's capture and cancel guides report "Transaction not found" by
    // webhook, not in the answer; that refunds behave alike is an assumption.
    const { adapter, fake } = withFake();
    await expect(adapter.refundPayment({ pspPaymentId: UNKNOWN_PAYMENT, idempotencyKey: "r" })).resolves.toMatchObject({
      status: "pending",
      amount: 1000,
    });
    await expect(adapter.capturePayment(UNKNOWN_PAYMENT, undefined, "c")).resolves.toMatchObject({
      status: "processing",
    });
    await expect(adapter.cancelPayment("8836100000000042", "v")).resolves.toMatchObject({ status: "processing" });
    expect([fake.uniqueRefundRequests, fake.uniqueCaptureRequests, fake.uniqueCancelRequests]).toEqual([1, 1, 1]);
  });

  it("rejects a refund whose acknowledgement echoes the amount of an earlier refund under the same key", async () => {
    const { adapter, fake } = withFake();
    const { pspPaymentId } = await pay(adapter, "complete-1");
    const accepted = await adapter.refundPayment({ pspPaymentId, amount: 500, idempotencyKey: "refund-1" });
    const error = await rejection(adapter.refundPayment({ pspPaymentId, amount: 400, idempotencyKey: "refund-1" }));
    expect(error).toMatchObject({ code: "invalid_request", retryable: false, pspName: "adyen" });
    // It states what Adyen holds under the key, and never advises a second refund.
    expect(error.message).toBe(
      `Adyen already accepted a refund of 500 EUR under this idempotencyKey (pspReference ${accepted.refundId}). ` +
        "If that is the refund you meant, do not send it again; a further refund needs a new idempotencyKey.",
    );
    expect(error.raw).toMatchObject({ status: "received", amount: { value: 500, currency: "EUR" } });
    // Adyen answered from its store: the second refund was never requested.
    expect(fake.uniqueRefundRequests).toBe(1);
  });

  it("rejects a capture whose acknowledgement echoes another amount or currency", async () => {
    const { adapter } = withFake();
    const { pspPaymentId } = await pay(adapter, "complete-1", "manual");
    await adapter.capturePayment(pspPaymentId, 1500, "capture-1");
    await expect(adapter.capturePayment(pspPaymentId, 2500, "capture-1")).rejects.toMatchObject({
      code: "invalid_request",
      retryable: false,
    });

    const { adapter: dollars } = answering(
      201,
      JSON.stringify({ pspReference: "8836100000000077", status: "received", amount: { value: 1000, currency: "USD" } }),
    );
    await expect(dollars.capturePayment(UNKNOWN_PAYMENT, 1000, "capture-2")).rejects.toMatchObject({
      code: "invalid_request",
      retryable: false,
    });
  });

  it("matches an echoed currency whatever its letter case", async () => {
    const { adapter } = answering(
      201,
      JSON.stringify({ pspReference: "8836100000000077", status: "received", amount: { value: 1000, currency: "eur" } }),
    );
    await expect(adapter.capturePayment(UNKNOWN_PAYMENT, 1000, "c")).resolves.toMatchObject({ status: "processing" });
    await expect(
      adapter.refundPayment({ pspPaymentId: UNKNOWN_PAYMENT, amount: 1000, idempotencyKey: "r" }),
    ).resolves.toMatchObject({ status: "pending", refundId: "8836100000000077" });
  });

  it("rejects every 2xx that is not an acknowledgement, on all three calls, without a TypeError", async () => {
    const calls = {
      capture: (adapter: AdyenServerAdapter) => adapter.capturePayment(UNKNOWN_PAYMENT, undefined, "k"),
      cancel: (adapter: AdyenServerAdapter) => adapter.cancelPayment(UNKNOWN_PAYMENT, "k"),
      refund: (adapter: AdyenServerAdapter) => adapter.refundPayment({ pspPaymentId: UNKNOWN_PAYMENT, idempotencyKey: "k" }),
    };
    for (const [name, call] of Object.entries(calls)) {
      // Not a JSON object: replayed under the same key, then psp_unavailable.
      for (const body of ["", "<html>OK</html>", "[]", "null", "42"]) {
        const { adapter, calls: sent } = answering(201, body);
        const error = await rejection(call(adapter));
        expect(error, `${name} answered ${JSON.stringify(body)}`).toMatchObject({
          code: "psp_unavailable",
          retryable: true,
          raw: { status: 201, body },
        });
        expect(sent()).toBe(3);
      }
      // A JSON object that confirms nothing: retryable, since a replay under the
      // same key cannot repeat the modification.
      for (const body of ["{}", '{"status":"received"}', '{"pspReference":""}', '{"pspReference":8836100000000077}']) {
        const { adapter, calls: sent } = answering(201, body);
        const error = await rejection(call(adapter));
        expect(error, `${name} answered ${body}`).toMatchObject({ code: "processing_error", retryable: true });
        expect(error.raw).toEqual(JSON.parse(body));
        expect(sent()).toBe(1);
      }
    }
    // An absent or null echo is accepted: Adyen's refund guide shows
    // acknowledgements without one, and refusing them would report accepted
    // refunds as failed.
    for (const body of [
      { pspReference: "8836100000000077", status: "received" },
      { pspReference: "8836100000000077", status: "received", amount: null },
    ]) {
      const { adapter } = answering(201, JSON.stringify(body));
      await expect(calls.capture(adapter)).resolves.toMatchObject({ status: "processing" });
      await expect(calls.refund(adapter)).resolves.toMatchObject({ status: "pending", refundId: "8836100000000077" });
    }
    // An echo that is present must be well formed; a cancel carries none.
    for (const body of [
      { pspReference: "8836100000000077", status: "received", amount: "1000 EUR" },
      { pspReference: "8836100000000077", status: "received", amount: { value: "1000", currency: "EUR" } },
      { pspReference: "8836100000000077", status: "received", amount: { value: 10.5, currency: "EUR" } },
      { pspReference: "8836100000000077", status: "received", amount: { value: 1000 } },
    ]) {
      const { adapter } = answering(201, JSON.stringify(body));
      await expect(calls.capture(adapter)).rejects.toMatchObject({ code: "processing_error", retryable: true });
      await expect(calls.refund(adapter)).rejects.toMatchObject({ code: "processing_error", retryable: true });
      await expect(calls.cancel(adapter)).resolves.toMatchObject({ status: "processing" });
    }
  });
});

describe("HTTP error classification", () => {
  it("retries whatever Adyen marks transient-error: true, at any status", async () => {
    const transient = { transient: true };
    expect(mapAdyenError(422, GENERIC_422, transient)).toMatchObject({ code: "processing_error", retryable: true });
    expect(mapAdyenError(401, GENERIC_401, transient)).toMatchObject({ code: "processing_error", retryable: true });
    expect(mapAdyenError(500, GENERIC_500, transient)).toMatchObject({ code: "psp_unavailable", retryable: true });
    expect(
      mapAdyenError(503, { status: 503, errorCode: "703", message: "Required resource temporarily unavailable" }, transient),
    ).toMatchObject({ code: "psp_unavailable", retryable: true });

    const { adapter, fake } = withFake();
    fake.scriptedResponses.push({ status: 422, body: GENERIC_422, headers: { "transient-error": "true" } });
    await expect(adapter.cancelPayment("8836100000000042", "k")).resolves.toMatchObject({ status: "processing" });
    expect(fake.requests).toHaveLength(2);
    // The replay carries the very same key, so Adyen can answer it from its store.
    expect(fake.requests[1]!.idempotencyKey).toBe(fake.requests[0]!.idempotencyKey);

    const { adapter: other, fake: declined } = withFake();
    declined.scriptedResponses.push({ status: 422, body: GENERIC_422, headers: { "transient-error": "false" } });
    await expect(other.cancelPayment("8836100000000042", "k")).rejects.toMatchObject({
      code: "invalid_request",
      retryable: false,
    });
    expect(declined.requests).toHaveLength(1);
  });

  it("refuses a 5xx typed validation, configuration or security without retrying it", async () => {
    expect(mapAdyenError(500, GENERIC_500)).toMatchObject({ code: "invalid_request", retryable: false });
    for (const errorType of ["validation", "security", "Configuration"]) {
      expect(mapAdyenError(500, { ...GENERIC_500, errorType })).toMatchObject({ code: "invalid_request", retryable: false });
    }
    // Anything else in the 5xx range is still Adyen's trouble.
    expect(mapAdyenError(500, { ...GENERIC_500, errorType: "internal" })).toMatchObject({
      code: "psp_unavailable",
      retryable: true,
    });
    expect(mapAdyenError(503, "<html>Service Unavailable</html>")).toMatchObject({
      code: "psp_unavailable",
      retryable: true,
    });

    const { adapter, fake } = withFake();
    fake.scriptedResponses.push({ status: 500, body: GENERIC_500 });
    await expect(adapter.cancelPayment("8836100000000042", "k")).rejects.toMatchObject({ code: "invalid_request" });
    expect(fake.requests).toHaveLength(1);

    const { adapter: other, fake: flaky } = withFake();
    flaky.scriptedResponses.push({ status: 500, body: { ...GENERIC_500, errorType: "internal" } });
    await expect(other.cancelPayment("8836100000000042", "k")).resolves.toMatchObject({ status: "processing" });
    expect(flaky.requests).toHaveLength(2);
  });

  it("retries a plain 5xx even under transient-error: false, deliberately", async () => {
    // Adyen stores no request an internal error stopped, and the retry carries
    // the same key, so it cannot perform a modification twice.
    const internal = { ...GENERIC_500, errorType: "internal" };
    expect(mapAdyenError(500, internal, { transient: false })).toMatchObject({ code: "psp_unavailable", retryable: true });

    const { adapter, fake } = withFake();
    fake.scriptedResponses.push({ status: 500, body: internal, headers: { "transient-error": "false" } });
    await expect(
      adapter.refundPayment({ pspPaymentId: UNKNOWN_PAYMENT, amount: 500, idempotencyKey: "k" }),
    ).resolves.toMatchObject({ status: "pending" });
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[1]!.idempotencyKey).toBe(fake.requests[0]!.idempotencyKey);
    expect(fake.uniqueRefundRequests).toBe(1);
  });

  it("reads the transient-error header case-insensitively, ignoring surrounding whitespace", async () => {
    let calls = 0;
    const adapter = makeAdapter({
      // A bare response object: Response itself would strip the whitespace
      // before the adapter could see it.
      fetch: async () =>
        (++calls === 1
          ? {
              ok: false,
              status: 422,
              headers: { get: (name: string) => (name === "transient-error" ? " TRUE " : null) },
              text: async () => JSON.stringify(GENERIC_422),
            }
          : new Response(JSON.stringify({ pspReference: "8836100000000077", status: "received" }), {
              status: 201,
            })) as Response,
    });
    await expect(adapter.cancelPayment("8836100000000042", "k")).resolves.toMatchObject({ status: "processing" });
    expect(calls).toBe(2);

    const { adapter: other, fake } = withFake();
    fake.scriptedResponses.push({ status: 422, body: GENERIC_422, headers: { "transient-error": "True" } });
    await expect(other.cancelPayment("8836100000000042", "k")).resolves.toMatchObject({ status: "processing" });
    expect(fake.requests).toHaveLength(2);
  });

  it("reads errorCode 705 as rate limiting, whatever the status", async () => {
    const rateLimited = { status: 500, errorCode: "705", message: "Rate limited", errorType: "internal" };
    expect(mapAdyenError(500, rateLimited)).toMatchObject({ code: "rate_limited", retryable: true });
    expect(mapAdyenError(422, { ...rateLimited, status: 422, errorType: "validation" })).toMatchObject({
      code: "rate_limited",
      retryable: true,
    });
    expect(mapAdyenError(429, undefined, { transient: true })).toMatchObject({ code: "rate_limited", retryable: true });

    const { adapter, fake } = withFake();
    fake.scriptedResponses.push({ status: 500, body: rateLimited });
    await expect(adapter.refundPayment({ pspPaymentId: UNKNOWN_PAYMENT, idempotencyKey: "k" })).resolves.toMatchObject(
      { status: "pending" },
    );
    expect(fake.requests).toHaveLength(2);
  });

  it("retries a 408 and refuses a 501", async () => {
    expect(mapAdyenError(408, undefined)).toMatchObject({ code: "psp_unavailable", retryable: true });
    expect(mapAdyenError(501, undefined)).toMatchObject({ code: "invalid_request", retryable: false });

    const { adapter, fake } = withFake();
    fake.scriptedResponses.push({ status: 408, rawBody: "" });
    await expect(adapter.cancelPayment("8836100000000042", "k")).resolves.toMatchObject({ status: "processing" });
    expect(fake.requests).toHaveLength(2);

    const { adapter: other, fake: unsupported } = withFake();
    unsupported.scriptedResponses.push({ status: 501, rawBody: "" });
    await expect(other.cancelPayment("8836100000000042", "k")).rejects.toMatchObject({
      code: "invalid_request",
      retryable: false,
    });
    expect(unsupported.requests).toHaveLength(1);
  });
});

describe("refusals and refund reasons", () => {
  it("maps refusal reason 31 (Issuer Suspected Fraud) to fraud_suspected", async () => {
    expect(mapAdyenRefusal({ resultCode: "Refused", refusalReasonCode: "31" })).toMatchObject({
      code: "fraud_suspected",
      retryable: false,
    });
    const { adapter } = withFake();
    const session = await adapter.createPaymentSession({ amount: 2500, currency: "EUR", idempotencyKey: "s" });
    await expect(
      adapter.completePayment({
        pspSessionId: session.pspSessionId,
        clientToken: JSON.stringify({ ...JSON.parse(CLIENT_TOKEN), holderName: "REFUSED:31" }),
        idempotencyKey: "c",
      }),
    ).rejects.toMatchObject({ code: "fraud_suspected", retryable: false });
  });

  it("sends the refund reason in Adyen's merchantRefundReason vocabulary, and nothing without one", async () => {
    const { adapter, fake } = withFake();
    const cases = [
      ["duplicate", "DUPLICATE"],
      ["fraudulent", "FRAUD"],
      ["requested_by_customer", "CUSTOMER REQUEST"],
    ] as const;
    for (const [reason, merchantRefundReason] of cases) {
      const refund = await adapter.refundPayment({
        pspPaymentId: UNKNOWN_PAYMENT,
        amount: 100,
        reason,
        idempotencyKey: `refund-${reason}`,
      });
      expect(fake.lastRequestBody).toMatchObject({ merchantRefundReason });
      expect(refund.raw).toMatchObject({ merchantRefundReason });
    }
    await adapter.refundPayment({ pspPaymentId: UNKNOWN_PAYMENT, amount: 100, idempotencyKey: "refund-none" });
    expect(fake.lastRequestBody).not.toHaveProperty("merchantRefundReason");
    // A reason outside the contract's vocabulary is withheld rather than guessed.
    await adapter.refundPayment({
      pspPaymentId: UNKNOWN_PAYMENT,
      amount: 100,
      reason: "damaged" as never,
      idempotencyKey: "refund-other",
    });
    expect(fake.lastRequestBody).not.toHaveProperty("merchantRefundReason");
  });
});
