import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isPayFanoutError } from "@payfanout/core";
import {
  ADYEN_IDEMPOTENCY_KEY_MAX_LENGTH,
  AdyenServerAdapter,
  decodeAdyenPaymentRef,
  decodeSessionContext,
  deriveAdyenIdempotencyKey,
  encodeAdyenPaymentRef,
  encodeSessionContext,
  hexToBytes,
  mapAdyenError,
  mapAdyenResultCode,
  parseAdyenWebhookEvents,
  type AdyenServerAdapterConfig,
  type AdyenSessionContextV1,
} from "../src/index.js";

const HMAC_KEY = "44782DEF547AAA06C910C43932B1EB0C71FC68D9D0C057550C48EC2ACF6BA056";

function makeAdapter(overrides: Partial<AdyenServerAdapterConfig>): AdyenServerAdapter {
  return new AdyenServerAdapter({
    apiKey: "checkout-api-key",
    merchantAccount: "TestMerchant",
    environment: "sandbox",
    sessionSigningKey: "sk",
    hmacKeys: [HMAC_KEY],
    webhookBasicAuth: { username: "u", password: "p" },
    sleep: async () => {},
    ...overrides,
  });
}

describe("edge-runtime compatibility", () => {
  it("the adapter's runtime sources use no Node-only builtins (WebCrypto only)", async () => {
    // Static guard: node:crypto/Buffer sneaking back in would silently break
    // Cloudflare Workers / Next.js edge deployments.
    const { readdir, readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const srcDir = fileURLToPath(new URL("../src", import.meta.url));
    const offenders: string[] = [];
    for (const file of await readdir(srcDir)) {
      const content = await readFile(join(srcDir, file), "utf8");
      if (/from "node:|require\("node:|Buffer\./.test(content)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});

describe("transport edge cases", () => {
  it("maps a network failure (fetch rejects) to retryable psp_unavailable", async () => {
    const adapter = makeAdapter({
      fetch: async () => {
        throw new TypeError("fetch failed: ECONNREFUSED");
      },
    });
    try {
      await adapter.cancelPayment("8836100000000001", "k");
      expect.unreachable();
    } catch (err) {
      expect(isPayFanoutError(err)).toBe(true);
      if (isPayFanoutError(err)) {
        expect(err.code).toBe("psp_unavailable");
        expect(err.retryable).toBe(true);
        expect(err.raw).toBeInstanceOf(TypeError);
      }
    }
  });

  it("times out a stalled exchange as retryable psp_unavailable", async () => {
    const adapter = makeAdapter({
      requestTimeoutMs: 5,
      maxNetworkRetries: 0,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    await expect(adapter.cancelPayment("8836100000000001", "k")).rejects.toMatchObject({
      code: "psp_unavailable",
      retryable: true,
    });
  });

  it("survives non-JSON error bodies from proxies/load balancers", async () => {
    const adapter = makeAdapter({
      fetch: async () => new Response("<html>502 Bad Gateway</html>", { status: 502 }),
    });
    await expect(adapter.cancelPayment("8836100000000001", "k")).rejects.toMatchObject({
      code: "psp_unavailable",
      retryable: true,
    });
  });

  it("requires explicit environment, credentials and a live URL prefix on live", () => {
    expect(() => makeAdapter({ environment: "prod" as never })).toThrowError(/sandbox.*live/);
    expect(() => makeAdapter({ apiKey: "" })).toThrowError(/apiKey/);
    expect(() => makeAdapter({ merchantAccount: "" })).toThrowError(/merchantAccount/);
    expect(() => makeAdapter({ sessionSigningKey: "" })).toThrowError(/sessionSigningKey/);
    expect(() => makeAdapter({ hmacKeys: [] })).toThrowError(/hmacKeys/);
    // A mistyped key must fail here, not on the first webhook in production.
    expect(() => makeAdapter({ hmacKeys: ["not-hex"] })).toThrowError(/hex/);
    expect(() => makeAdapter({ hmacKeys: [HMAC_KEY, "0f0"] })).toThrowError(/hex/);
    expect(() => makeAdapter({ webhookBasicAuth: [] })).toThrowError(/webhookBasicAuth/);
    expect(() => makeAdapter({ environment: "live" })).toThrowError(/liveUrlPrefix/);
    expect(() => makeAdapter({ apiVersion: "72" })).toThrowError(/apiVersion/);
    expect(() => makeAdapter({ sessionTtlSeconds: 0 })).toThrowError(/sessionTtlSeconds/);
    expect(() => makeAdapter({ requestTimeoutMs: 0 })).toThrowError(/requestTimeoutMs/);
    expect(() => makeAdapter({ maxNetworkRetries: -1 })).toThrowError(/maxNetworkRetries/);
  });

  it("derives one idempotency header per endpoint, deterministically and within Adyen's limit", async () => {
    const payments = await deriveAdyenIdempotencyKey("/payments", "caller-key");
    expect(payments).toMatch(/^[0-9a-f]{64}$/);
    expect(payments.length).toBeLessThanOrEqual(ADYEN_IDEMPOTENCY_KEY_MAX_LENGTH);
    // Same call, same key: Adyen replays its stored response instead of charging twice.
    expect(await deriveAdyenIdempotencyKey("/payments", "caller-key")).toBe(payments);
    // Adyen stores keys per company account, so a second endpoint must not
    // inherit the first one's stored response.
    expect(await deriveAdyenIdempotencyKey("/payments/details", "caller-key")).not.toBe(payments);
    expect(await deriveAdyenIdempotencyKey("/payments", "another-key")).not.toBe(payments);
  });

  it("rejects a hex HMAC key that is not hex", () => {
    expect(() => hexToBytes("zz")).toThrowError(/hex/);
    expect(() => hexToBytes("abc")).toThrowError(/hex/);
    expect(hexToBytes("00ff")).toEqual(new Uint8Array([0, 255]));
  });
});

describe("error and status mapping", () => {
  it("replays a 409 only when Adyen marks it transient", () => {
    const transient = mapAdyenError(409, { status: 409, message: "in progress" }, { transient: true });
    expect(transient).toMatchObject({ code: "processing_error", retryable: true });
    const permanent = mapAdyenError(409, { status: 409, message: "conflict" });
    expect(permanent).toMatchObject({ code: "processing_error", retryable: false });
    // A duplicate racing the in-flight original resolves itself moments later.
    const duplicate = mapAdyenError(422, { status: 422, errorCode: "704", message: "in progress" });
    expect(duplicate).toMatchObject({ code: "processing_error", retryable: true });
  });

  it("classifies the documented HTTP statuses", () => {
    expect(mapAdyenError(401, { status: 401 })).toMatchObject({ code: "invalid_request", retryable: false });
    expect(mapAdyenError(403, { status: 403 })).toMatchObject({ code: "invalid_request", retryable: false });
    expect(mapAdyenError(422, { status: 422 })).toMatchObject({ code: "invalid_request", retryable: false });
    expect(mapAdyenError(429, { status: 429 })).toMatchObject({ code: "rate_limited", retryable: true });
    expect(mapAdyenError(500, undefined)).toMatchObject({ code: "psp_unavailable", retryable: true });
    // The raw PSP error is never dropped, even when the body was not JSON.
    expect(mapAdyenError(500, undefined).raw).toEqual({ status: 500 });
  });

  it("maps every documented resultCode", () => {
    expect(mapAdyenResultCode("Authorised", "automatic")).toBe("succeeded");
    expect(mapAdyenResultCode("Authorised", "manual")).toBe("requires_capture");
    expect(mapAdyenResultCode("Cancelled", "automatic")).toBe("canceled");
    expect(mapAdyenResultCode("Refused", "automatic")).toBe("failed");
    expect(mapAdyenResultCode("Error", "automatic")).toBe("failed");
    expect(mapAdyenResultCode("Received", "automatic")).toBe("processing");
    expect(mapAdyenResultCode("Pending", "automatic")).toBe("processing");
    expect(mapAdyenResultCode("AuthenticationFinished", "automatic")).toBe("processing");
    expect(mapAdyenResultCode("AuthenticationNotRequired", "automatic")).toBe("processing");
    expect(mapAdyenResultCode("RedirectShopper", "automatic")).toBe("requires_action");
    expect(mapAdyenResultCode("IdentifyShopper", "automatic")).toBe("requires_action");
    expect(mapAdyenResultCode("ChallengeShopper", "automatic")).toBe("requires_action");
    expect(mapAdyenResultCode("PresentToShopper", "automatic")).toBe("requires_action");
    expect(mapAdyenResultCode("PartiallyAuthorised", "automatic")).toBe("requires_action");
    // An unknown resultCode is underway, never silently successful.
    expect(mapAdyenResultCode("SomethingNew", "automatic")).toBe("processing");
  });
});

describe("push-only payment references", () => {
  it("round-trips the money facts and tolerates a bare pspReference", () => {
    const composite = encodeAdyenPaymentRef("8836100000000001", 2500, "EUR");
    expect(composite).toBe("8836100000000001:2500:EUR");
    expect(decodeAdyenPaymentRef(composite)).toEqual({
      pspReference: "8836100000000001",
      amount: 2500,
      currency: "EUR",
    });
    expect(decodeAdyenPaymentRef("8836100000000001")).toEqual({ pspReference: "8836100000000001" });
    // A malformed composite is treated as an opaque reference, not as money.
    expect(decodeAdyenPaymentRef("ref:not-a-number:EUR")).toEqual({ pspReference: "ref:not-a-number:EUR" });
    expect(decodeAdyenPaymentRef("ref:100:EURO")).toEqual({ pspReference: "ref:100:EURO" });
  });
});

describe("the signed session context", () => {
  const KEY = "session-signing-key";
  const context: AdyenSessionContextV1 = {
    v: 1,
    amount: 2500,
    currency: "EUR",
    captureMethod: "manual",
    reference: "order-1",
    expiresAt: 2_000_000_000_000,
    returnUrl: "https://host.example/return",
    id: "order-1",
    metadata: { plan: "pro" },
    receiptEmail: "shopper@example.test",
  };

  /** Signs an arbitrary payload the way encodeSessionContext does. */
  function token(payload: string, key = KEY): string {
    const encoded = Buffer.from(payload, "utf8").toString("base64url");
    return `${encoded}.${createHmac("sha256", key).update(encoded, "utf8").digest("base64url")}`;
  }

  it("round-trips every field it carries", async () => {
    const encoded = await encodeSessionContext(context, KEY);
    await expect(decodeSessionContext(encoded, KEY, { now: 1_000 })).resolves.toEqual(context);
  });

  it("rejects a malformed, unsigned or foreign-signed token", async () => {
    const encoded = await encodeSessionContext(context, KEY);
    await expect(decodeSessionContext("no-signature-here", KEY)).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(decodeSessionContext(encoded, "another-key")).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  it("rejects a signed payload that is not a v1 context", async () => {
    await expect(decodeSessionContext(token("not json"), KEY)).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(
      decodeSessionContext(token(JSON.stringify({ ...context, v: 2 })), KEY),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      decodeSessionContext(token(JSON.stringify({ ...context, amount: "2500" })), KEY),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("rejects a token with no expiry rather than treating it as eternal", async () => {
    const { expiresAt: _expiresAt, ...withoutExpiry } = context;
    await expect(decodeSessionContext(token(JSON.stringify(withoutExpiry)), KEY)).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(
      decodeSessionContext(token(JSON.stringify({ ...context, expiresAt: Number.POSITIVE_INFINITY })), KEY),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("expires on the adapter's clock, not on wall time", async () => {
    const encoded = await encodeSessionContext(context, KEY);
    await expect(decodeSessionContext(encoded, KEY, { now: context.expiresAt })).resolves.toBeDefined();
    await expect(decodeSessionContext(encoded, KEY, { now: context.expiresAt + 1 })).rejects.toMatchObject({
      code: "session_expired",
    });
  });
});

describe("batched deliveries", () => {
  it("fans a multi-item payload out rather than dropping trailing events", async () => {
    const item = (pspReference: string) => ({
      NotificationRequestItem: {
        eventCode: "AUTHORISATION",
        eventDate: "2026-08-02T11:00:00Z",
        merchantAccountCode: "TestMerchant",
        merchantReference: "order-77",
        pspReference,
        success: "true",
      },
    });
    const events = await parseAdyenWebhookEvents(
      JSON.stringify({ live: "false", notificationItems: [item("883610000000001"), item("883610000000002")] }),
    );
    expect(events.map((event) => event.id)).toEqual([
      "AUTHORISATION:883610000000001",
      "AUTHORISATION:883610000000002",
    ]);
  });
});
