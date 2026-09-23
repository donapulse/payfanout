import type {
  WorldlineCaptureLike,
  WorldlinePaymentLike,
  WorldlineRefundLike,
} from "../src/index.js";

/**
 * In-memory Worldline Direct Online Payments API. Models the documented
 * behavior the adapter relies on:
 *   - v1HMAC auth is present (Authorization: GCS v1HMAC:…); a lever forces 401
 *   - X-GCS-Idempotence-Key dedupe on the documented idempotent operations
 *     (create payment / capture / refund — exactly one creation per key), so
 *     the conformance idempotency proof holds; hostedtokenizations is
 *     deliberately NOT deduped, since CreateHostedTokenization is not on
 *     Worldline's idempotent-operations list
 *   - SALE (auto-capture) vs PRE_AUTHORIZATION (manual) payments, with separate
 *     capture and refund sub-resources (partial capture, over-refund
 *     rejection, cancel-before-capture); refunds are read ONLY via the
 *     per-payment list, as on the real platform (no refund-by-id route)
 *   - card declines as HTTP 402 with { errorId, errors, paymentResult }
 */
interface StoredPayment {
  id: string;
  amount: number;
  currencyCode: string;
  merchantReference?: string;
  status: string;
  statusCode: number;
  statusCategory: string;
  /** SALE (settle with auth) vs PRE_AUTHORIZATION. */
  sale: boolean;
  capturableRemaining: number;
  captures: WorldlineCaptureLike[];
  refunds: WorldlineRefundLike[];
}

/** Amount that triggers a decline (mirrors a Worldline sandbox amount trigger). */
const DECLINE_AMOUNT = 1302;
/** hostedTokenizationId that forces a 3-D Secure challenge (REDIRECT merchantAction). */
const THREE_DS_TOKEN = "htp_3ds";

export class FakeWorldlineApi {
  private readonly payments = new Map<string, StoredPayment>();
  private readonly paymentByIdemKey = new Map<string, StoredPayment>();
  private readonly captureByIdemKey = new Map<string, WorldlineCaptureLike>();
  private readonly refundByIdemKey = new Map<string, WorldlineRefundLike>();
  private seq = 0;
  uniquePaymentCreations = 0;
  uniqueCaptureCreations = 0;
  uniqueRefundCreations = 0;
  lastRequestBody: Record<string, unknown> | undefined;
  lastCreatePaymentBody: Record<string, unknown> | undefined;
  lastRequestPath: string | undefined;
  /** Test levers for the verifyCredentials probe. */
  authFailure = false;
  networkFailure = false;

  readonly fetch: typeof fetch = async (input, init) => {
    if (this.networkFailure) throw new TypeError("simulated network failure");
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const parsed = new URL(url);
    const path = parsed.pathname;
    this.lastRequestPath = path;
    const headers = lowercase((init?.headers as Record<string, string>) ?? {});
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    this.lastRequestBody = body;
    const idemKey = headers["x-gcs-idempotence-key"];

    if (this.authFailure || !headers["authorization"]?.startsWith("GCS v1HMAC:")) {
      return json(401, { errorId: "auth", errors: [{ code: "9002", message: "Unauthorized", httpStatusCode: 401 }] });
    }

    if (method === "GET" && /^\/v2\/[^/]+\/services\/testconnection$/.test(path)) {
      return json(200, { result: "OK" });
    }
    if (method === "POST" && /^\/v2\/[^/]+\/hostedtokenizations$/.test(path)) {
      const id = `htp_${++this.seq}`;
      return json(200, {
        hostedTokenizationId: id,
        hostedTokenizationUrl: `https://payment.preprod.direct.worldline-solutions.com/hostedtokenization/${id}`,
        partialRedirectUrl: `payment.preprod.direct.worldline-solutions.com/hostedtokenization/${id}`,
        invalidTokens: null,
      });
    }
    if (method === "POST" && /^\/v2\/[^/]+\/payments$/.test(path)) {
      return this.createPayment(body ?? {}, idemKey);
    }

    const captureMatch = /^\/v2\/[^/]+\/payments\/([^/]+)\/capture$/.exec(path);
    if (method === "POST" && captureMatch) return this.capture(decodeURIComponent(captureMatch[1]!), body ?? {}, idemKey);
    const cancelMatch = /^\/v2\/[^/]+\/payments\/([^/]+)\/cancel$/.exec(path);
    if (method === "POST" && cancelMatch) return this.cancel(decodeURIComponent(cancelMatch[1]!), idemKey);
    const refundMatch = /^\/v2\/[^/]+\/payments\/([^/]+)\/refund$/.exec(path);
    if (method === "POST" && refundMatch) return this.refund(decodeURIComponent(refundMatch[1]!), body ?? {}, idemKey);
    const capturesMatch = /^\/v2\/[^/]+\/payments\/([^/]+)\/captures$/.exec(path);
    if (method === "GET" && capturesMatch) {
      const payment = this.payments.get(decodeURIComponent(capturesMatch[1]!));
      if (!payment) return notFound();
      return json(200, { captures: payment.captures });
    }
    const refundsMatch = /^\/v2\/[^/]+\/payments\/([^/]+)\/refunds$/.exec(path);
    if (method === "GET" && refundsMatch) {
      const payment = this.payments.get(decodeURIComponent(refundsMatch[1]!));
      if (!payment) return notFound();
      return json(200, { refunds: payment.refunds });
    }
    const paymentMatch = /^\/v2\/[^/]+\/payments\/([^/]+)$/.exec(path);
    if (method === "GET" && paymentMatch) {
      const payment = this.payments.get(decodeURIComponent(paymentMatch[1]!));
      if (!payment) return notFound();
      return json(200, publicPayment(payment));
    }
    // Deliberately no GET /refunds/{id}: Worldline Direct has no refund-by-id
    // endpoint — the per-payment list above is the only refund read surface.
    return notFound(`No route ${method} ${path}`);
  };

  private createPayment(body: Record<string, unknown>, idemKey: string | undefined): Response {
    this.lastCreatePaymentBody = body;
    if (idemKey && this.paymentByIdemKey.has(idemKey)) {
      return json(201, createResponse(this.paymentByIdemKey.get(idemKey)!));
    }
    const order = (body["order"] ?? {}) as {
      amountOfMoney?: { amount?: number; currencyCode?: string };
      references?: { merchantReference?: string };
    };
    // hostedTokenizationId is a ROOT CreatePayment property on the real platform.
    const hostedTokenizationId = body["hostedTokenizationId"] as string | undefined;
    const card = (body["cardPaymentMethodSpecificInput"] ?? {}) as {
      authorizationMode?: string;
    };
    const amount = order.amountOfMoney?.amount ?? 0;
    const currencyCode = order.amountOfMoney?.currencyCode ?? "EUR";
    if (!hostedTokenizationId) {
      return json(400, {
        errorId: "val",
        errors: [{ code: "1", propertyName: "hostedTokenizationId", message: "required", httpStatusCode: 400 }],
      });
    }
    if (amount === DECLINE_AMOUNT) {
      // Documented decline shape: HTTP 402 with errors[] and paymentResult.
      return json(402, {
        errorId: `err_${++this.seq}`,
        errors: [
          { errorCode: "GENERIC_DECLINE", category: "PAYMENT_PLATFORM_ERROR", httpStatusCode: 402, message: "Payment rejected", retriable: false },
        ],
        status: 402,
        paymentResult: {
          payment: { id: `pay_${++this.seq}`, status: "REJECTED", statusOutput: { statusCode: 2, statusCategory: "UNSUCCESSFUL" } },
        },
      });
    }
    const id = `pay_${++this.seq}`;
    const sale = (card.authorizationMode ?? "SALE").toUpperCase() !== "PRE_AUTHORIZATION";
    if (hostedTokenizationId === THREE_DS_TOKEN) {
      const payment: StoredPayment = {
        id, amount, currencyCode, merchantReference: order.references?.merchantReference,
        status: "REDIRECTED", statusCode: 46, statusCategory: "PENDING_CONNECT_OR_3RD_PARTY",
        sale, capturableRemaining: sale ? 0 : amount, captures: [], refunds: [],
      };
      this.store(payment, idemKey);
      return json(201, {
        creationOutput: { tokens: "" },
        merchantAction: { actionType: "REDIRECT", redirectData: { redirectURL: "https://payment.preprod.direct.worldline-solutions.com/3ds/challenge" } },
        payment: publicPayment(payment),
      });
    }
    const payment: StoredPayment = {
      id, amount, currencyCode, merchantReference: order.references?.merchantReference,
      status: sale ? "CAPTURED" : "PENDING_CAPTURE",
      statusCode: sale ? 9 : 5,
      statusCategory: sale ? "COMPLETED" : "PENDING_MERCHANT",
      sale,
      capturableRemaining: sale ? 0 : amount,
      captures: sale
        ? [{ id: `cap_${++this.seq}`, status: "CAPTURED", statusOutput: { statusCode: 9, statusCategory: "COMPLETED" }, captureOutput: { amountOfMoney: { amount, currencyCode } } }]
        : [],
      refunds: [],
    };
    this.store(payment, idemKey);
    return json(201, createResponse(payment));
  }

  private store(payment: StoredPayment, idemKey: string | undefined): void {
    this.payments.set(payment.id, payment);
    if (idemKey) this.paymentByIdemKey.set(idemKey, payment);
    this.uniquePaymentCreations++;
  }

  private capture(id: string, body: Record<string, unknown>, idemKey: string | undefined): Response {
    const payment = this.payments.get(id);
    if (!payment) return notFound();
    if (idemKey && this.captureByIdemKey.has(idemKey)) return json(201, this.captureByIdemKey.get(idemKey)!);
    const amount = (body["amount"] as number | undefined) ?? payment.capturableRemaining;
    // A capture always finalizes, so a payment is capturable at most once — a sale
    // (auto-captured), an already-captured payment, or an over-capture is rejected.
    // A capture the acquirer refused does not count: the authorisation stands.
    if (payment.sale || this.hasSettledCapture(payment) || amount <= 0 || amount > payment.capturableRemaining) {
      return json(400, { errorId: "cap", errors: [{ code: "5", message: "Payment not in a capturable state", httpStatusCode: 400 }] });
    }
    if (this.captureRefused) {
      // Statuses reference: the capture object carries REJECTED_CAPTURE and only
      // a statusCode (CaptureStatusOutput has no category), GetPayment lists 93
      // under REJECTED_CAPTURE/UNSUCCESSFUL, and the authorisation stays
      // capturable ("you can retry the operation").
      const refused: WorldlineCaptureLike = {
        id: `cap_${++this.seq}`,
        status: "REJECTED_CAPTURE",
        statusOutput: { statusCode: 93 },
        captureOutput: { amountOfMoney: { amount, currencyCode: payment.currencyCode } },
      };
      payment.captures.push(refused);
      payment.status = "REJECTED_CAPTURE";
      payment.statusCode = 93;
      payment.statusCategory = "UNSUCCESSFUL";
      if (idemKey) this.captureByIdemKey.set(idemKey, refused);
      this.uniqueCaptureCreations++;
      return json(201, refused);
    }
    const capture: WorldlineCaptureLike = {
      id: `cap_${++this.seq}`,
      status: "CAPTURED",
      statusOutput: { statusCode: 9 },
      captureOutput: { amountOfMoney: { amount, currencyCode: payment.currencyCode } },
    };
    payment.captures.push(capture);
    // Finalized: the captured amount settled, the uncaptured remainder released.
    payment.capturableRemaining = 0;
    payment.status = "CAPTURED";
    payment.statusCode = 9;
    payment.statusCategory = "COMPLETED";
    if (idemKey) this.captureByIdemKey.set(idemKey, capture);
    this.uniqueCaptureCreations++;
    return json(201, capture);
  }

  /** CancelPayment outcomes by X-GCS-Idempotence-Key, answered again to a replay. */
  private readonly cancelByIdemKey = new Map<string, { status: number; body: unknown }>();

  private cancel(id: string, idemKey: string | undefined): Response {
    const payment = this.payments.get(id);
    if (!payment) return notFound();
    // CancelPayment is idempotent: a completed request replayed under its key
    // answers "the same outcome as the original request" (idempotent-requests
    // guide), whatever happened to the payment since.
    const original = idemKey ? this.cancelByIdemKey.get(idemKey) : undefined;
    if (original) return json(original.status, original.body);
    const outcome = this.cancelOutcome(payment);
    if (idemKey) this.cancelByIdemKey.set(idemKey, outcome);
    return json(outcome.status, outcome.body);
  }

  private cancelOutcome(payment: StoredPayment): { status: number; body: unknown } {
    // API contract, CancelPayment 409: "Cancellation is not allowed because payment is closed".
    const cancelled = payment.status === "CANCELLED" && payment.statusCode === 6;
    if (payment.sale || this.hasSettledCapture(payment) || cancelled) {
      return {
        status: 409,
        body: {
          errorId: "cxl",
          errors: [{ code: "409", message: "Cancellation is not allowed because payment is closed", httpStatusCode: 409 }],
        },
      };
    }
    // Statuses reference, CancelPayment outcomes: CANCELLED/UNSUCCESSFUL/6 is
    // final, CANCELLED/PENDING_MERCHANT/61 awaits the acquirer, and
    // CANCELLATION_REJECTED/UNSUCCESSFUL/63 leaves the payment authorised.
    if (this.cancelRejected) {
      // "The payment reverts to its previous state": the stored payment is left
      // as it was, so an authorisation keeps reading back PENDING_CAPTURE/5.
      return {
        status: 200,
        body: {
          payment: publicPayment({ ...payment, status: "CANCELLATION_REJECTED", statusCode: 63, statusCategory: "UNSUCCESSFUL" }),
        },
      };
    }
    payment.capturableRemaining = 0;
    payment.status = "CANCELLED";
    payment.statusCategory = "UNSUCCESSFUL";
    if (this.cancelPending) {
      // GetPayment lists 61 under CANCELLED/UNSUCCESSFUL while CancelPayment
      // answers it as PENDING_MERCHANT; each read follows its own table.
      payment.statusCode = 61;
      return {
        status: 200,
        body: { payment: { ...publicPayment(payment), statusOutput: { statusCode: 61, statusCategory: "PENDING_MERCHANT" } } },
      };
    }
    payment.statusCode = 6;
    return { status: 200, body: { payment: publicPayment(payment) } };
  }

  private refund(id: string, body: Record<string, unknown>, idemKey: string | undefined): Response {
    const payment = this.payments.get(id);
    if (!payment) return notFound();
    if (idemKey && this.refundByIdemKey.has(idemKey)) return json(201, this.refundByIdemKey.get(idemKey)!);
    const money = (body["amountOfMoney"] ?? {}) as { amount?: number; currencyCode?: string };
    const amount = money.amount ?? 0;
    // Refused captures and refunds moved no money, so they neither fund nor use
    // up the refundable amount (a refused refund can be retried).
    const capturedTotal = payment.captures
      .filter((c) => c.status !== "REJECTED_CAPTURE")
      .reduce((sum, c) => sum + (c.captureOutput?.amountOfMoney?.amount ?? 0), 0);
    const refundedTotal = payment.refunds
      .filter((r) => r.status !== "REJECTED")
      .reduce((sum, r) => sum + (r.refundOutput?.amountOfMoney?.amount ?? 0), 0);
    if (amount <= 0 || refundedTotal + amount > capturedTotal) {
      return json(400, { errorId: "rfd", errors: [{ code: "5", message: "Refund exceeds the refundable amount", httpStatusCode: 400 }] });
    }
    const refund: WorldlineRefundLike = {
      id: `ref_${++this.seq}`,
      status: this.refundPending ? "REFUND_REQUESTED" : "REFUNDED",
      statusOutput: this.refundPending
        ? { statusCode: 81, statusCategory: "PENDING_CONNECT_OR_3RD_PARTY" }
        : { statusCode: 8, statusCategory: "REFUNDED" },
      refundOutput: { amountOfMoney: { amount, currencyCode: money.currencyCode ?? payment.currencyCode } },
    };
    if (this.refundPending) {
      // Statuses reference: the payment reads back REFUND_REQUESTED/REVERSED/81
      // until the acquirer answers (8 refunded, or 83 refused).
      payment.status = "REFUND_REQUESTED";
      payment.statusCode = 81;
      payment.statusCategory = "REVERSED";
    }
    payment.refunds.push(refund);
    if (idemKey) this.refundByIdemKey.set(idemKey, refund);
    this.uniqueRefundCreations++;
    return json(201, refund);
  }

  /**
   * Test helper: seed a refund in an arbitrary status (e.g. pending) under a
   * payment, for retrieveRefund — refunds are only readable through the
   * per-payment list, so a refund cannot exist without its payment.
   */
  seedRefund(paymentId: string, refund: Partial<WorldlineRefundLike> = {}): WorldlineRefundLike {
    let payment = this.payments.get(paymentId);
    if (!payment) {
      payment = {
        id: paymentId,
        amount: 1000,
        currencyCode: "EUR",
        status: "CAPTURED",
        statusCode: 9,
        statusCategory: "COMPLETED",
        sale: true,
        capturableRemaining: 0,
        captures: [],
        refunds: [],
      };
      this.payments.set(paymentId, payment);
    }
    const stored: WorldlineRefundLike = {
      id: refund.id ?? `ref_${++this.seq}`,
      status: refund.status ?? "REFUND_REQUESTED",
      // Statuses reference: REFUND_REQUESTED sits in PENDING_CONNECT_OR_3RD_PARTY.
      statusOutput: refund.statusOutput ?? { statusCode: 81, statusCategory: "PENDING_CONNECT_OR_3RD_PARTY" },
      refundOutput: refund.refundOutput ?? { amountOfMoney: { amount: 1000, currencyCode: "EUR" } },
    };
    payment.refunds.push(stored);
    return stored;
  }

  /*
   * Maintenance-outcome levers, all off by default. Each switches the matching
   * operation to another outcome documented in Worldline's Statuses reference.
   */
  /** CancelPayment answers 61 (Author. deletion waiting): the acquirer has not confirmed the cancellation. */
  cancelPending = false;
  /** The acquirer refuses the cancellation (63): the payment remains authorised. */
  cancelRejected = false;
  /** The acquirer refuses the capture (93): the authorisation stands and can be captured again. */
  captureRefused = false;
  /** RefundPayment answers 81 (Refund pending); settle it with refuseRefund. */
  refundPending = false;

  /**
   * Test helper: the acquirer refuses a pending refund (83, Refund refused).
   * The refund turns REJECTED and GetPayment lists the payment under
   * REJECTED/UNSUCCESSFUL/83, though the money stays captured.
   */
  refuseRefund(paymentId: string, refundId: string): void {
    const payment = this.payments.get(paymentId);
    const refund = payment?.refunds.find((r) => r.id === refundId);
    if (!payment || !refund) throw new Error(`No refund ${refundId} on payment ${paymentId}`);
    refund.status = "REJECTED";
    refund.statusOutput = { statusCode: 83, statusCategory: "UNSUCCESSFUL" };
    payment.status = "REJECTED";
    payment.statusCode = 83;
    payment.statusCategory = "UNSUCCESSFUL";
  }

  private hasSettledCapture(payment: StoredPayment): boolean {
    return payment.captures.some((c) => c.status !== "REJECTED_CAPTURE");
  }
}

function publicPayment(payment: StoredPayment): WorldlinePaymentLike {
  return {
    id: payment.id,
    status: payment.status,
    statusOutput: { statusCode: payment.statusCode, statusCategory: payment.statusCategory },
    paymentOutput: {
      amountOfMoney: { amount: payment.amount, currencyCode: payment.currencyCode },
      ...(payment.merchantReference ? { references: { merchantReference: payment.merchantReference } } : {}),
      cardPaymentMethodSpecificOutput: {
        card: { cardNumber: "************4675", expiryDate: "1230" },
        paymentProductId: 1,
      },
    },
  };
}

function createResponse(payment: StoredPayment): {
  creationOutput: unknown;
  payment: WorldlinePaymentLike;
} {
  return { creationOutput: { tokens: "" }, payment: publicPayment(payment) };
}

function lowercase(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = value;
  return out;
}

function notFound(message = "Unknown entity"): Response {
  return json(404, { errorId: "nf", errors: [{ code: "1", message, httpStatusCode: 404 }] });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
