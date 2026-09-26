import { describe, expect, it, vi } from "vitest";
import type { VerifyCredentialsResult } from "@payfanout/core";
import { WorldlineServerAdapter, type WorldlineServerAdapterConfig } from "../src/index.js";

const PROBE_URL = "https://payment.preprod.direct.worldline-solutions.com/v2/mid-1/services/testconnection";

const AUTH_FAILED: VerifyCredentialsResult = {
  ok: false,
  category: "auth",
  message: "Authentication failed — check the Worldline API key id, secret API key, merchantId and environment, and the server's clock.",
};
const UNREACHABLE: VerifyCredentialsResult = {
  ok: false,
  category: "network",
  message: "Could not reach Worldline — try again.",
};

/** What a host reads for a 2xx that is not the test-connection service's answer. */
function withoutResult(status: number): VerifyCredentialsResult {
  return {
    ok: false,
    category: "internal",
    message: `Worldline answered the connectivity check without an OK result (HTTP ${status}) — check baseUrl.`,
  };
}

/** What a host reads for any other answer; `detail` is "HTTP 404" or "HTTP 404, UNKNOWN_PAYMENT_ID". */
function rejected(detail: string): VerifyCredentialsResult {
  return {
    ok: false,
    category: "internal",
    message: `Worldline rejected the connectivity check (${detail}) — check baseUrl and merchantId.`,
  };
}

/** Every `errors[].id` the API Troubleshooting guide and the manual-authentication guide name. */
const DOCUMENTED_ERROR_IDS = [
  "ACCESS_TO_MERCHANT_NOT_ALLOWED",
  "UNKNOWN_PAYMENT_ID",
  "UNKNOWN_REFUND_ID",
  "UNKNOWN_PAYOUT_ID",
  "UNKNOWN_CAPTURE_ID",
  "UNKNOWN_PRODUCT_ID",
  "UNKNOWN_PRODUCT_GROUP_ID",
  "UNKNOWN_PRODUCT_IDS",
  "UNKNOWN_PRODUCT_GROUP_IDS",
  "INVALID_VALUE",
  "ACTION_NOT_ALLOWED_ON_TRANSACTION",
  "PAYMENT_PRODUCT_NOT_AVAILABLE",
  "UNKNOWN_TOKEN_ID",
  "CARDNUMBER_PAYMENTPRODUCTID_MISMATCH",
  "PAYMENT_PRODUCT_NOT_REFUNDABLE",
  "AUTHENTICATION_FAILURE",
  "INVALID_DATA",
  "SCHEMA_VALIDATION_FAILED",
];

interface RecordedRequest {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
}

/** An adapter whose every request is answered by `answer`, recording each request. */
function probing(
  answer: () => Response,
  config: Partial<WorldlineServerAdapterConfig> = {},
): { adapter: WorldlineServerAdapter; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const adapter = new WorldlineServerAdapter({
    apiKeyId: "fake-api-key-id",
    secretApiKey: "fake-secret-api-key",
    merchantId: "mid-1",
    environment: "sandbox",
    sessionSigningKey: "session-signing-key",
    webhookKeys: [{ keyId: "wh-key-1", secretKey: "webhook-secret" }],
    fetch: async (input, init) => {
      requests.push({ url: String(input), method: init?.method, headers: { ...(init?.headers as Record<string, string>) } });
      return answer();
    },
    ...config,
  });
  return { adapter, requests };
}

/** An adapter whose every request is answered with `status` and exactly `body`. */
function answering(
  status: number,
  body: string | null,
  config?: Partial<WorldlineServerAdapterConfig>,
): { adapter: WorldlineServerAdapter; requests: RecordedRequest[] } {
  return probing(() => new Response(body, { status }), config);
}

/** A Worldline error envelope, in the shape of the API Troubleshooting guide's examples. */
function errorBody(errors: unknown): string {
  return JSON.stringify({ errorId: "8c0e1431-4c6c-4fcf-8c58-c8c083730968", errors });
}

/** A 404 whose one error carries `id`. */
function answeringId(id: unknown, config?: Partial<WorldlineServerAdapterConfig>): WorldlineServerAdapter {
  return answering(404, errorBody([{ errorCode: "50001130", category: "DIRECT_PLATFORM_ERROR", httpStatusCode: 404, id }]), config)
    .adapter;
}

describe("Worldline verifyCredentials (Test connection probe)", () => {
  it("reports ok for a 2xx carrying the OK result, after one signed GET", async () => {
    // "If you receive an OK result you know that your connection with us is working correctly" (Connect S2S reference).
    const answers: Array<[number, unknown]> = [
      [200, { result: "OK" }],
      // New response fields are a backwards-compatible change (API versioning guide).
      [200, { result: "OK", checkedAt: "2026-09-26T10:00:00Z" }],
      [201, { result: "OK" }],
    ];
    for (const [status, body] of answers) {
      const { adapter, requests } = answering(status, JSON.stringify(body));
      await expect(adapter.verifyCredentials(), JSON.stringify(body)).resolves.toEqual({ ok: true });
      expect(requests, JSON.stringify(body)).toEqual([
        {
          url: PROBE_URL,
          method: "GET",
          headers: expect.objectContaining({ authorization: expect.stringMatching(/^GCS v1HMAC:fake-api-key-id:/) }),
        },
      ]);
    }
  });

  it("reports a 2xx without the OK result as a failure, never ok", async () => {
    // A baseUrl naming a host that is not the API, such as a web page, answers 2xx with something else.
    const answers: Array<[number, string | null]> = [
      [200, "<html><body>Sign in</body></html>"],
      [200, "{}"],
      // Any other result is no OK: Worldline's Magento, PrestaShop and SAP Commerce plugins fail the check on it too.
      [200, JSON.stringify({ result: "Invalid" })],
      [200, JSON.stringify({ result: "NOK" })],
      [200, JSON.stringify({ result: "ok" })],
      [200, JSON.stringify({ result: "OK " })],
      [200, JSON.stringify({ result: "any other text" })],
      [200, JSON.stringify({ result: "" })],
      [200, JSON.stringify({ result: ["OK"] })],
      [200, JSON.stringify({ result: null })],
      [200, JSON.stringify({ result: 1 })],
      [200, JSON.stringify({ result: true })],
      [200, JSON.stringify({ result: { status: "OK" } })],
      [200, JSON.stringify({ Result: "OK" })],
      [200, JSON.stringify("OK")],
      [200, JSON.stringify([{ result: "OK" }])],
      [200, "null"],
      // A 2xx names no error id, even from an error envelope.
      [200, errorBody([{ errorCode: "50001130", httpStatusCode: 404, id: "UNKNOWN_PAYMENT_ID" }])],
      [201, "{}"],
      [204, null],
      [299, ""],
    ];
    for (const [status, body] of answers) {
      const { adapter, requests } = answering(status, body);
      await expect(adapter.verifyCredentials(), `${status} ${String(body)}`).resolves.toEqual(withoutResult(status));
      expect(requests, `${status} ${String(body)}`).toHaveLength(1);
    }
  });

  it("keeps auth rejections and transient answers in their buckets, after a single request", async () => {
    // A key, secret or PSPID the platform cannot match (manual-authentication guide).
    const unmatched = JSON.stringify({
      errorId: "error-id",
      errors: [
        {
          code: "9007",
          id: "ACCESS_TO_MERCHANT_NOT_ALLOWED",
          category: "DIRECT_PLATFORM_ERROR",
          message: "ACCESS_TO_MERCHANT_NOT_ALLOWED",
          httpStatusCode: 403,
        },
      ],
      status: 403,
    });
    const cases: Array<[number, string | null, VerifyCredentialsResult]> = [
      [403, unmatched, AUTH_FAILED],
      [403, null, AUTH_FAILED],
      [401, "Unauthorized", AUTH_FAILED],
      // The status decides, whatever the body carries.
      [403, JSON.stringify({ result: "OK" }), AUTH_FAILED],
      [403, "<html>Forbidden</html>", AUTH_FAILED],
      [429, null, UNREACHABLE],
      [500, errorBody([{ code: "9999", message: "UNKNOWN_SERVER_ERROR", httpStatusCode: 500 }]), UNREACHABLE],
      [502, "<html>502 Bad Gateway</html>", UNREACHABLE],
      [503, JSON.stringify({ result: "OK" }), UNREACHABLE],
      [504, null, UNREACHABLE],
      [599, null, UNREACHABLE],
    ];
    for (const [status, body, expected] of cases) {
      const { adapter, requests } = answering(status, body);
      await expect(adapter.verifyCredentials(), `${status} ${String(body)}`).resolves.toEqual(expected);
      expect(requests, `${status} ${String(body)}`).toHaveLength(1);
    }
    const { adapter, requests } = probing(() => {
      throw new TypeError("fetch failed");
    });
    await expect(adapter.verifyCredentials()).resolves.toEqual(UNREACHABLE);
    expect(requests).toHaveLength(1);
    // With a baseUrl override, a 403 can also come from whatever host answers there.
    const overridden = answering(403, null, { baseUrl: "https://payment.preprod.direct.worldline-solutions.com" });
    await expect(overridden.adapter.verifyCredentials()).resolves.toEqual({
      ...AUTH_FAILED,
      message:
        "Authentication failed — check the Worldline API key id, secret API key, merchantId, environment and baseUrl, and the server's clock.",
    });
  });

  it("reports a probe that outlives requestTimeoutMs as unreachable, at that timeout and after one request", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let calls = 0;
      let aborted = false;
      let fetchCalled: () => void = () => undefined;
      const fetched = new Promise<void>((resolve) => {
        fetchCalled = resolve;
      });
      const { adapter } = probing(
        () => {
          throw new Error("the injected fetch below answers instead");
        },
        {
          requestTimeoutMs: 20,
          fetch: (_input, init) => {
            calls += 1;
            fetchCalled();
            return new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener(
                "abort",
                () => {
                  aborted = true;
                  reject(new DOMException("The operation was aborted.", "AbortError"));
                },
                { once: true },
              );
            });
          },
        },
      );
      const result = adapter.verifyCredentials();
      // The timer is armed before fetch is called.
      await fetched;
      await vi.advanceTimersByTimeAsync(19);
      expect(aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(aborted).toBe(true);
      await expect(result).resolves.toEqual(UNREACHABLE);
      expect(calls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports any other status as a failure, naming the status and Worldline's error id", async () => {
    const cases: Array<[number, string | null, string]> = [
      // "Technical error (non-existent/wrong API endpoint)": an empty body.
      [404, "", "HTTP 404"],
      [404, null, "HTTP 404"],
      [404, "<html><body>Not Found</body></html>", "HTTP 404"],
      [
        404,
        errorBody([
          {
            errorCode: "50001130",
            category: "DIRECT_PLATFORM_ERROR",
            code: "1002",
            httpStatusCode: 404,
            id: "UNKNOWN_PAYMENT_ID",
            message: "UNKNOWN_PAYMENT_ID",
            propertyName: "paymentId",
            retriable: false,
          },
        ]),
        "HTTP 404, UNKNOWN_PAYMENT_ID",
      ],
      [
        400,
        errorBody([{ errorCode: "50001111", category: "DIRECT_PLATFORM_ERROR", code: "1008", httpStatusCode: 400, id: "INVALID_VALUE" }]),
        "HTTP 400, INVALID_VALUE",
      ],
      // Only errorCode is required: an error without an id names none.
      [400, errorBody([{ errorCode: "50001066", httpStatusCode: 400 }]), "HTTP 400"],
      [410, errorBody([]), "HTTP 410"],
      [402, errorBody([{ errorCode: "40001134", httpStatusCode: 402, id: "AUTHENTICATION_FAILURE" }]), "HTTP 402, AUTHENTICATION_FAILURE"],
      // The probe sends no idempotence key, so a 409 is no replay still in flight.
      [409, errorBody([{ errorCode: "1409", httpStatusCode: 409 }]), "HTTP 409"],
      [300, null, "HTTP 300"],
      [399, "moved", "HTTP 399"],
    ];
    for (const [status, body, detail] of cases) {
      const { adapter, requests } = answering(status, body);
      await expect(adapter.verifyCredentials(), detail).resolves.toEqual(rejected(detail));
      expect(requests, detail).toHaveLength(1);
    }
    // An injected fetch can hand back a network-error Response (status 0) instead of rejecting.
    const { adapter } = probing(() => Response.error());
    await expect(adapter.verifyCredentials()).resolves.toEqual(rejected("HTTP 0"));
  });

  it("names every error id Worldline documents", async () => {
    for (const id of DOCUMENTED_ERROR_IDS) {
      await expect(answeringId(id).verifyCredentials(), id).resolves.toEqual(rejected(`HTTP 404, ${id}`));
    }
  });

  it("names only an id that reads as a Worldline error id, and only the first error's", async () => {
    const statusOnly = rejected("HTTP 404");
    for (const id of [
      "unknown_payment_id",
      "uNKNOWN_PAYMENT_ID",
      "Unknown_Payment_Id",
      "UNKNOWN-PAYMENT-ID",
      "UNKNOWN.PAYMENT.ID",
      "UNKNOWN PAYMENT ID",
      "4UNKNOWN_PAYMENT_ID",
      "_UNKNOWN_PAYMENT_ID",
      "<b>UNKNOWN_PAYMENT_ID</b>",
      "UNKNOWN_PAYMENT_ID\n",
      "",
      "A".repeat(65),
      404,
      null,
      true,
      ["UNKNOWN_PAYMENT_ID"],
      { id: "UNKNOWN_PAYMENT_ID" },
    ]) {
      await expect(answeringId(id).verifyCredentials(), JSON.stringify(id)).resolves.toEqual(statusOnly);
    }
    // A capital, then up to 63 capitals, digits and underscores.
    for (const id of ["A", "A".repeat(64), "HTTP_404_NOT_FOUND"]) {
      await expect(answeringId(id).verifyCredentials(), id).resolves.toEqual(rejected(`HTTP 404, ${id}`));
    }
    // The first error decides: a later one is never read instead.
    for (const errors of [
      [{ errorCode: "50001130", id: "unknown-payment-id" }, { errorCode: "50001111", id: "INVALID_VALUE" }],
      [{ errorCode: "50001130" }, { errorCode: "50001111", id: "INVALID_VALUE" }],
      [null, { errorCode: "50001111", id: "INVALID_VALUE" }],
      [7, { errorCode: "50001111", id: "INVALID_VALUE" }],
      ["INVALID_VALUE"],
    ]) {
      const { adapter } = answering(404, errorBody(errors));
      await expect(adapter.verifyCredentials(), JSON.stringify(errors)).resolves.toEqual(statusOnly);
    }
    const { adapter: both } = answering(
      404,
      errorBody([{ errorCode: "50001130", id: "UNKNOWN_PAYMENT_ID" }, { errorCode: "50001111", id: "INVALID_VALUE" }]),
    );
    await expect(both.verifyCredentials()).resolves.toEqual(rejected("HTTP 404, UNKNOWN_PAYMENT_ID"));
    // A body whose errors are not a list names none.
    for (const body of [
      { errorId: "x", errors: { id: "UNKNOWN_PAYMENT_ID" } },
      { errorId: "x", errors: "UNKNOWN_PAYMENT_ID" },
      { errorId: "x", errors: 7 },
      { errorId: "x", errors: null },
      { errorId: "x" },
      { id: "UNKNOWN_PAYMENT_ID" },
      [{ id: "UNKNOWN_PAYMENT_ID" }],
      "UNKNOWN_PAYMENT_ID",
    ]) {
      const { adapter } = answering(404, JSON.stringify(body));
      await expect(adapter.verifyCredentials(), JSON.stringify(body)).resolves.toEqual(statusOnly);
    }
  });

  it("never names an id that repeats a credential, or eight characters of one in any letter case", async () => {
    // Whatever answers a wrong baseUrl writes the body, and the request named the API key id.
    const credentials = {
      apiKeyId: "FAKEKEYID0123456789",
      secretApiKey: "fAkE/SECRETKEY42+aPiKeY0987654321=",
    };
    const statusOnly = rejected("HTTP 404");
    for (const id of [
      "FAKEKEYID0123456789",
      "FAKEKEYID0123456789_ECHOED",
      "ECHO_FAKEKEYI",
      "ECHO_23456789",
      "KEYID012",
      "SECRETKEY42",
      "APIKEY09",
    ]) {
      await expect(answeringId(id, credentials).verifyCredentials(), id).resolves.toEqual(statusOnly);
    }
    // Seven characters of a credential, or an id sharing none of it, is named.
    for (const id of ["KEYID01", "APIKEY0", "UNKNOWN_PAYMENT_ID"]) {
      await expect(answeringId(id, credentials).verifyCredentials(), id).resolves.toEqual(rejected(`HTTP 404, ${id}`));
    }
    // A credential shorter than eight characters is withheld whole.
    const short = { apiKeyId: "K7" };
    await expect(answeringId("K7_ECHO", short).verifyCredentials()).resolves.toEqual(statusOnly);
    await expect(answeringId("K_7_ECHO", short).verifyCredentials()).resolves.toEqual(rejected("HTTP 404, K_7_ECHO"));
  });
});
