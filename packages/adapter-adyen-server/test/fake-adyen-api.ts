/**
 * In-memory Adyen Checkout API for ONE company account. Models the documented
 * behavior the adapter relies on:
 *   - `X-API-Key` authentication; a lever forces 401
 *   - `idempotency-key` dedupe on every POST (Adyen honors the header on POST
 *     only and keeps keys for 7 to 14 days), so the conformance idempotency
 *     proof holds: one side effect per key, the first stored response replayed
 *     verbatim on every reuse, whatever the request. The keys are stored at
 *     COMPANY ACCOUNT level, not per endpoint or merchant account, so the replay
 *     map is keyed on the header alone and shared by every adapter talking to
 *     this fake, whichever merchant account it books against
 *   - POST /payments requiring every field Adyen marks required (`merchantAccount`,
 *     `reference`, `amount`, `paymentMethod` and `returnUrl`), returning
 *     `pspReference` + `resultCode`, with an `action` for a 3-D Secure challenge
 *     and a refusal carrying `refusalReasonCode`
 *   - POST /payments/details finishing an action
 *   - captures / cancels / refunds answering `{ status: "received" }` ONLY, each
 *     with its own pspReference, captures and refunds echoing the amount sent —
 *     for ANY payment reference and whatever the payment's state. Adyen's
 *     capture and cancel guides list "Transaction not found" among the failures
 *     their webhook reports, so an unknown reference is acknowledged there; that
 *     a refund on one is acknowledged and fails by webhook too is an assumption
 *     (the refund guide's failure reasons do not list it), as is that a cancel
 *     after the capture fails in the CANCELLATION webhook (the cancel guide says
 *     only that a captured payment can no longer be cancelled). A reference from
 *     the other environment is rejected in the answer (error 906), which this
 *     fake does not model. The outcome exists nowhere else until the webhook
 *     lands, which is what makes Adyen push-only
 *
 * Validation errors carry Adyen's envelope shape (`status`, `message`,
 * `errorType`, `pspReference`) without an `errorCode`: the real codes live in
 * Adyen's error-code list, and the adapter classifies by HTTP status, by the
 * error type on a 5xx and by error codes 704 and 705 alone, so pinning invented
 * codes here would assert provider behavior the fake cannot vouch for. The
 * codes that ARE behavioral are modeled explicitly: 704 (a duplicate racing the
 * in-flight original) by `transientConflicts`, and any documented envelope or
 * header — 705, `transient-error`, a 5xx typed `configuration` — through
 * `scriptedResponses`.
 */
export interface StoredPayment {
  pspReference: string;
  value: number;
  currency: string;
  reference: string;
  manualCapture: boolean;
}

/**
 * The fake's own decline trigger. Adyen's sandbox drives refusals from
 * `paymentMethod.holderName` values and `additionalData.RequestedTestAcquirerResponseCode`
 * on its testing page; the adapter forwards the paymentMethod blob untouched, so
 * a holder name of `REFUSED` (optionally `REFUSED:<refusalReasonCode>`) is all
 * this fake needs to exercise the mapping.
 */
const REFUSAL_TRIGGER = /^REFUSED(?::(\d+))?$/;
/** Holder name that makes the fake answer with a 3-D Secure action instead of a result. */
const CHALLENGE_TRIGGER = "CHALLENGE";

/** The `merchantRefundReason` values the Checkout API accepts on a refund. */
const MERCHANT_REFUND_REASONS = ["FRAUD", "CUSTOMER REQUEST", "RETURN", "DUPLICATE", "OTHER"];

/** An answer served as is, before routing, authentication and the idempotency store. */
export interface ScriptedResponse {
  status: number;
  /** Serialized as JSON unless `rawBody` is set. */
  body?: unknown;
  /** Sent verbatim: a body no Adyen endpoint sends (an HTML page, nothing at all). */
  rawBody?: string;
  headers?: Record<string, string>;
}

export interface RecordedRequest {
  path: string;
  idempotencyKey: string | undefined;
  body: Record<string, unknown> | undefined;
}

export class FakeAdyenApi {
  private readonly payments = new Map<string, StoredPayment>();
  private readonly replayByKey = new Map<string, { status: number; body: unknown }>();
  private seq = 0;
  uniquePaymentCreations = 0;
  uniqueCaptureRequests = 0;
  uniqueCancelRequests = 0;
  uniqueRefundRequests = 0;
  /** Requests answered from the idempotency store instead of being performed. */
  replays = 0;
  /** Every request received, in order, scripted answers included. */
  readonly requests: RecordedRequest[] = [];
  lastPaymentBody: Record<string, unknown> | undefined;
  lastRequestBody: Record<string, unknown> | undefined;
  lastRequestPath: string | undefined;
  lastIdempotencyKey: string | undefined;
  /** Test levers. */
  authFailure = false;
  networkFailure = false;
  rateLimited = false;
  serverError = false;
  /** Answers this many 409s (transient) before serving the request. */
  transientConflicts = 0;
  /** Served first, one per request, in order. */
  scriptedResponses: ScriptedResponse[] = [];

  readonly fetch: typeof fetch = async (input, init) => {
    if (this.networkFailure) throw new TypeError("simulated network failure");
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url).pathname;
    const headers = lowercase((init?.headers as Record<string, string>) ?? {});
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    this.lastRequestPath = path;
    this.lastRequestBody = body;
    this.lastIdempotencyKey = headers["idempotency-key"];
    this.requests.push({ path, idempotencyKey: headers["idempotency-key"], body });

    const scripted = this.scriptedResponses.shift();
    if (scripted) {
      return new Response(scripted.rawBody ?? JSON.stringify(scripted.body), {
        status: scripted.status,
        headers: { "content-type": "application/json", ...scripted.headers },
      });
    }
    if (this.authFailure || !headers["x-api-key"]) {
      return json(401, { status: 401, message: "HTTP Status Response - Unauthorized", errorType: "security" });
    }
    if (this.rateLimited) {
      return json(429, { status: 429, message: "Too many requests", errorType: "security" });
    }
    if (this.serverError) {
      return json(503, { status: 503, message: "Service unavailable", errorType: "internal" });
    }
    if (this.transientConflicts > 0) {
      this.transientConflicts--;
      return json(
        409,
        { status: 409, errorCode: "704", message: "Request already in progress", errorType: "validation" },
        { "transient-error": "true" },
      );
    }

    const key = headers["idempotency-key"];
    if (key && this.replayByKey.has(key)) {
      const replayed = this.replayByKey.get(key)!;
      this.replays++;
      return json(replayed.status, replayed.body);
    }

    const result = this.route(path, init?.method ?? "GET", body ?? {});
    // Adyen stores the outcome under the key, error responses included.
    if (key) this.replayByKey.set(key, result);
    return json(result.status, result.body);
  };

  /** Plants a payment so a modification can be exercised without a completion. */
  seedPayment(payment: Partial<StoredPayment> = {}): StoredPayment {
    const stored: StoredPayment = {
      pspReference: payment.pspReference ?? this.nextReference(),
      value: payment.value ?? 1000,
      currency: payment.currency ?? "EUR",
      reference: payment.reference ?? "seeded",
      manualCapture: payment.manualCapture ?? false,
    };
    this.payments.set(stored.pspReference, stored);
    return stored;
  }

  private route(path: string, method: string, body: Record<string, unknown>): { status: number; body: unknown } {
    if (method !== "POST") return notFound(`No route ${method} ${path}`);
    if (/\/payments$/.test(path)) return this.createPayment(body);
    if (/\/payments\/details$/.test(path)) return this.submitDetails(body);
    const modification = /\/payments\/([^/]+)\/(captures|cancels|refunds)$/.exec(path);
    if (modification) {
      return this.modify(decodeURIComponent(modification[1]!), modification[2]!, body);
    }
    return notFound(`No route ${method} ${path}`);
  }

  private createPayment(body: Record<string, unknown>): { status: number; body: unknown } {
    this.lastPaymentBody = body;
    const amount = (body["amount"] ?? {}) as { value?: number; currency?: string };
    const paymentMethod = (body["paymentMethod"] ?? {}) as Record<string, unknown>;
    // returnUrl is one of the required top-level fields on POST /payments, as
    // required as merchantAccount and reference — omitting it is a 422.
    for (const field of ["merchantAccount", "reference", "returnUrl"] as const) {
      if (!body[field]) return validationError(`Required field '${field}' is not provided.`);
    }
    if (typeof amount.value !== "number" || !amount.currency) {
      return validationError("Required field 'amount' is not provided.");
    }
    if (typeof paymentMethod["type"] !== "string") {
      return validationError("Required field 'paymentMethod' is not provided.");
    }
    const pspReference = this.nextReference();
    const holderName = typeof paymentMethod["holderName"] === "string" ? paymentMethod["holderName"] : "";
    const refusal = REFUSAL_TRIGGER.exec(holderName);
    if (refusal) {
      return {
        status: 200,
        body: {
          pspReference,
          resultCode: "Refused",
          refusalReason: "Refused",
          refusalReasonCode: refusal[1] ?? "2",
          merchantReference: body["reference"],
        },
      };
    }
    if (holderName === CHALLENGE_TRIGGER) {
      return {
        status: 200,
        body: {
          pspReference,
          resultCode: "ChallengeShopper",
          action: {
            type: "threeDS2",
            subtype: "challenge",
            token: "challenge-token",
            paymentData: `paymentData-${pspReference}`,
          },
        },
      };
    }
    const manualCapture = ((body["additionalData"] ?? {}) as Record<string, string>)["manualCapture"] === "true";
    this.payments.set(pspReference, {
      pspReference,
      value: amount.value,
      currency: String(amount.currency),
      reference: String(body["reference"]),
      manualCapture,
    });
    this.uniquePaymentCreations++;
    return {
      status: 200,
      body: {
        pspReference,
        resultCode: "Authorised",
        merchantReference: body["reference"],
        amount: { value: amount.value, currency: amount.currency },
      },
    };
  }

  private submitDetails(body: Record<string, unknown>): { status: number; body: unknown } {
    if (!body["details"]) return validationError("Required field 'details' is not provided.");
    const pspReference = this.nextReference();
    // A finished action answers with the authorisation's own pspReference.
    this.payments.set(pspReference, {
      pspReference,
      value: 0,
      currency: "EUR",
      reference: "details",
      manualCapture: false,
    });
    this.uniquePaymentCreations++;
    return { status: 200, body: { pspReference, resultCode: "Authorised" } };
  }

  private modify(
    pspReference: string,
    operation: string,
    body: Record<string, unknown>,
  ): { status: number; body: unknown } {
    // No lookup of the payment: an unknown reference is acknowledged like any
    // other and fails in the outcome webhook, as documented for captures and
    // cancels and assumed for refunds.
    if (!body["merchantAccount"]) return validationError("Required field 'merchantAccount' is not provided.");
    const amount = (body["amount"] ?? {}) as { value?: number; currency?: string };
    if (operation !== "cancels" && (typeof amount.value !== "number" || !amount.currency)) {
      return validationError("Required field 'amount' is not provided.");
    }
    const reason = body["merchantRefundReason"];
    if (operation === "refunds" && reason !== undefined && !MERCHANT_REFUND_REASONS.includes(String(reason))) {
      return validationError("Field 'merchantRefundReason' is not valid.");
    }
    if (operation === "captures") this.uniqueCaptureRequests++;
    if (operation === "cancels") this.uniqueCancelRequests++;
    if (operation === "refunds") this.uniqueRefundRequests++;
    return {
      status: 201,
      body: {
        merchantAccount: body["merchantAccount"],
        paymentPspReference: pspReference,
        // The modification's OWN reference — never the payment's.
        pspReference: this.nextReference(),
        // The only status a modification ever answers with.
        status: "received",
        ...(operation === "cancels" ? {} : { amount }),
        ...(reason === undefined ? {} : { merchantRefundReason: reason }),
      },
    };
  }

  /** Adyen pspReferences are 16 alphanumeric characters. */
  private nextReference(): string {
    return `88361${String(++this.seq).padStart(11, "0")}`;
  }
}

function lowercase(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = value;
  return out;
}

function validationError(message: string): { status: number; body: unknown } {
  return { status: 422, body: { status: 422, message, errorType: "validation", pspReference: "" } };
}

function notFound(message: string): { status: number; body: unknown } {
  return { status: 404, body: { status: 404, message, errorType: "validation" } };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
