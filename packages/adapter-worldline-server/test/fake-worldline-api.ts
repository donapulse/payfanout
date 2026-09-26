import type {
  WorldlineApiError,
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
 *   - CreatePayment answers a key it has seen with the stored original answer,
 *     status and body, whatever the new payload, plus
 *     X-GCS-Idempotence-Request-Timestamp carrying the first request's time
 *   - SALE (auto-capture) vs PRE_AUTHORIZATION (manual) payments, with separate
 *     capture and refund sub-resources (partial capture, over-refund
 *     rejection, cancel-before-capture); refunds are read ONLY via the
 *     per-payment list, as on the real platform (no refund-by-id route)
 *   - card declines as HTTP 402 with { errorId, errors, paymentResult }, the
 *     REJECTED payment they create included, or, behind a lever, as a 201
 *     carrying a REJECTED payment
 *   - authorisations the platform has not finished (50, 51, 52), answered
 *     201 at AUTHORIZATION_REQUESTED, or behind a lever as a 402 carrying such
 *     a payment, and settled later with settlePendingAuthorization
 *   - GetPayment failing behind a lever: 404 with the UNKNOWN_PAYMENT_ID body
 *     of the API Troubleshooting page, or 503
 *   - order.references.merchantParameters, a string of at most 1000
 *     characters (UTF-16 code units, as for the other limits here), stored and
 *     echoed as paymentOutput.references.merchantParameters on reads and
 *     webhooks, never on the deprecated paymentOutput.merchantParameters
 *   - paymentOutput.transactionDate, stamped when the payment is created and
 *     left as it is by later operations: the creation-time reading of "the
 *     server-side processing date and time of the transaction", which no
 *     sandbox run has confirmed yet
 */
interface StoredPayment {
  id: string;
  amount: number;
  currencyCode: string;
  merchantReference?: string;
  merchantParameters?: string;
  /** In the API contract example's form, "2019-08-24T14:15:22Z". */
  transactionDate: string;
  status: string;
  statusCode: number;
  statusCategory: string;
  /** SALE (settle with auth) vs PRE_AUTHORIZATION. */
  sale: boolean;
  capturableRemaining: number;
  captures: WorldlineCaptureLike[];
  refunds: WorldlineRefundLike[];
  /** statusOutput.errors: why a REJECTED payment failed. */
  errors?: WorldlineApiError[];
}

/** Amount that triggers a decline (mirrors a Worldline sandbox amount trigger). */
const DECLINE_AMOUNT = 1302;
/** hostedTokenizationId that forces a 3-D Secure challenge (REDIRECT merchantAction). */
const THREE_DS_TOKEN = "htp_3ds";

/** The API contract's cardPaymentMethodSpecificInput.transactionChannel values. */
const TRANSACTION_CHANNELS = new Set<unknown>(["ECOMMERCE", "MOTO"]);

/** The API contract's paymentProduct130SpecificThreeDSecure.usecase values. */
const CARTES_BANCAIRES_USE_CASES = new Set<unknown>([
  "single-amount",
  "fixed-amount-term-subscription",
  "payment-by-instalments",
  "payment-upon-shipment",
  "other-recurring-payments",
]);

/**
 * Statuses reference: 50 "Authorised waiting external result" (fraud
 * screening), 51 "Authorisation waiting" (the acquirer) and 52 "Authorisation
 * not known". GetPayment lists 50 and 51 under AUTHORIZATION_REQUESTED /
 * PENDING_CONNECT_OR_3RD_PARTY; 52 has no row there, so it takes the same pair.
 */
export type PendingAuthorizationCode = 50 | 51 | 52;

function pendingAuthorization(statusCode: PendingAuthorizationCode): Pick<StoredPayment, "status" | "statusCode" | "statusCategory"> {
  return { status: "AUTHORIZATION_REQUESTED", statusCode, statusCategory: "PENDING_CONNECT_OR_3RD_PARTY" };
}

/** A CreatePayment answer stored under its idempotence key, as first sent. */
interface StoredAnswer {
  status: number;
  body: string;
  /** When the key's first request arrived, in ms since the epoch. */
  requestedAt: number;
}

export class FakeWorldlineApi {
  private readonly payments = new Map<string, StoredPayment>();
  private readonly createAnswerByIdemKey = new Map<string, StoredAnswer>();
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
  /**
   * CreatePayment answers 201 with a REJECTED payment (2/UNSUCCESSFUL), carrying
   * these statusOutput.errors when given: the "Transaction exception" shape of
   * the API Troubleshooting page.
   */
  rejectPayment: { errors?: WorldlineApiError[] } | undefined = undefined;
  /** Cards, by hostedTokenizationId, the issuer declines with a 402 whatever the amount. */
  readonly declinedCards = new Set<string>();
  /** Cards, by hostedTokenizationId, whose authorisation CreatePayment answers 201 still pending, at that code. */
  readonly pendingCards = new Map<string, PendingAuthorizationCode>();
  /**
   * Cards, by hostedTokenizationId, CreatePayment refuses with a 402 whose
   * paymentResult reports the payment still pending, at that code. No page
   * shows such an answer, and the contract does not rule one out.
   */
  readonly refusedWhilePending = new Map<string, PendingAuthorizationCode>();
  /** Hosted tokenizations CreatePayment refuses with a 400 that creates no payment. */
  readonly invalidTokens = new Set<string>();
  /**
   * The next CreatePayment answers to lose: each request is processed and its
   * answer stored, then the connection fails before the answer arrives.
   */
  lostCreatePaymentAnswers = 0;
  /** The next CreatePayment connections to refuse: each request fails before the platform sees it. */
  refusedCreatePaymentConnections = 0;
  /** Replays carry a new errorId, as a platform that ids every error response would send. */
  freshErrorIdOnReplay = false;
  /** GET /payments/{id} answers this status instead of the payment, whatever the id. */
  paymentReadFailure: 404 | 503 | undefined = undefined;
  /**
   * The time a key's first CreatePayment is stamped with, in ms since the epoch,
   * and its payment's transactionDate; each one moves it on a second.
   */
  clock = Date.now();
  /** Every CreatePayment that reached the fake, in order: its idempotence key, and whether it replayed a stored answer. */
  readonly createPaymentLog: Array<{ idemKey: string | undefined; replayed: boolean }> = [];

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
      if (this.refusedCreatePaymentConnections > 0) {
        this.refusedCreatePaymentConnections--;
        throw new TypeError("simulated connection refused before the request reached the platform");
      }
      const answer = this.createPayment(body ?? {}, idemKey);
      if (this.lostCreatePaymentAnswers > 0) {
        this.lostCreatePaymentAnswers--;
        throw new TypeError("simulated connection reset after the request was processed");
      }
      return answer;
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
      if (this.paymentReadFailure === 404) return unknownPaymentId();
      if (this.paymentReadFailure === 503) return json(503, { errorId: "unavailable", errors: [{ httpStatusCode: 503 }] });
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
    const original = idemKey ? this.createAnswerByIdemKey.get(idemKey) : undefined;
    this.createPaymentLog.push({ idemKey, replayed: original !== undefined });
    if (original) {
      // "The same outcome as the original request, even with different
      // payloads", and the time of that request on the replay header.
      let replayed = original.body;
      if (this.freshErrorIdOnReplay) {
        const parsed = JSON.parse(replayed) as { errorId?: unknown };
        if (typeof parsed.errorId === "string") replayed = JSON.stringify({ ...parsed, errorId: `err_${++this.seq}` });
      }
      return new Response(replayed, {
        status: original.status,
        headers: { "content-type": "application/json", "X-GCS-Idempotence-Request-Timestamp": String(original.requestedAt) },
      });
    }
    const requestedAt = this.clock;
    this.clock += 1000;
    const { status, body: answer } = this.processCreatePayment(body, requestedAt);
    const serialized = JSON.stringify(answer);
    // Every answer the fake gives is a completed request's, a refusal included:
    // the guide's "For completed requests" read literally.
    if (idemKey) this.createAnswerByIdemKey.set(idemKey, { status, body: serialized, requestedAt });
    return new Response(serialized, { status, headers: { "content-type": "application/json" } });
  }

  private processCreatePayment(body: Record<string, unknown>, requestedAt: number): { status: number; body: unknown } {
    const order = (body["order"] ?? {}) as {
      amountOfMoney?: { amount?: number; currencyCode?: string };
      references?: { merchantReference?: string; softDescriptor?: string; merchantParameters?: unknown };
      customer?: { device?: unknown };
    };
    // hostedTokenizationId is a ROOT CreatePayment property on the real platform.
    const hostedTokenizationId = body["hostedTokenizationId"] as string | undefined;
    const card = (body["cardPaymentMethodSpecificInput"] ?? {}) as {
      authorizationMode?: string;
      transactionChannel?: unknown;
      returnUrl?: string;
      threeDSecure?: { redirectionData?: { returnUrl?: string } };
      paymentProduct130SpecificInput?: unknown;
    };
    const amount = order.amountOfMoney?.amount ?? 0;
    const currencyCode = order.amountOfMoney?.currencyCode ?? "EUR";
    const invalid = (propertyName: string, message: string) => ({
      status: 400,
      body: { errorId: `val_${++this.seq}`, errors: [{ code: "1", propertyName, message, httpStatusCode: 400 }] },
    });
    if (!hostedTokenizationId) return invalid("hostedTokenizationId", "required");
    // Regression guard: the client adapter's clientToken envelope, forwarded
    // whole as an earlier server adapter would, is not a hosted tokenization id.
    if (hostedTokenizationId.startsWith("{")) return invalid("hostedTokenizationId", "unknown hosted tokenization");
    // The 3-D Secure guide lists this among the properties every card payment
    // must send, so the fake refuses a payment that omits it.
    if (!card.threeDSecure?.redirectionData?.returnUrl) {
      return invalid("cardPaymentMethodSpecificInput.threeDSecure.redirectionData.returnUrl", "required");
    }
    // The API contract caps both return URL forms at 200 characters and rejects a URL without a protocol.
    const returnUrls: Array<[string, string | undefined]> = [
      ["cardPaymentMethodSpecificInput.threeDSecure.redirectionData.returnUrl", card.threeDSecure.redirectionData.returnUrl],
      ["cardPaymentMethodSpecificInput.returnUrl", card.returnUrl],
    ];
    for (const [propertyName, returnUrl] of returnUrls) {
      if (returnUrl === undefined) continue;
      if (returnUrl.length > 200) return invalid(propertyName, "exceeds 200 characters");
      if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(returnUrl)) return invalid(propertyName, "must contain a protocol");
    }
    // The API contract's enum on the channel, and its types, enum and limits on
    // the Cartes Bancaires 3-D Secure data.
    if (card.transactionChannel !== undefined && !TRANSACTION_CHANNELS.has(card.transactionChannel)) {
      return invalid("cardPaymentMethodSpecificInput.transactionChannel", "not an allowed value");
    }
    const cartesBancaires = card.paymentProduct130SpecificInput;
    if (cartesBancaires !== undefined) {
      const path = "cardPaymentMethodSpecificInput.paymentProduct130SpecificInput";
      if (!isObject(cartesBancaires)) return invalid(path, "must be an object");
      const threeDSecure = cartesBancaires["threeDSecure"] === undefined ? {} : cartesBancaires["threeDSecure"];
      if (!isObject(threeDSecure)) return invalid(`${path}.threeDSecure`, "must be an object");
      const fields: Array<[string, unknown, (value: unknown) => boolean]> = [
        ["usecase", threeDSecure["usecase"], (value) => CARTES_BANCAIRES_USE_CASES.has(value)],
        ["numberOfItems", threeDSecure["numberOfItems"], (value) => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 99],
        ["acquirerExemption", threeDSecure["acquirerExemption"], flag],
        ["merchantScore", threeDSecure["merchantScore"], text(20)],
      ];
      for (const [field, value, valid] of fields) {
        if (value !== undefined && !valid(value)) return invalid(`${path}.threeDSecure.${field}`, "outside the documented type or limit");
      }
    }
    // The API contract caps orderReferences.merchantReference at 40 characters and softDescriptor at 256.
    if ((order.references?.merchantReference?.length ?? 0) > 40) {
      return invalid("order.references.merchantReference", "exceeds 40 characters");
    }
    if ((order.references?.softDescriptor?.length ?? 0) > 256) {
      return invalid("order.references.softDescriptor", "exceeds 256 characters");
    }
    // The API contract types orderReferences.merchantParameters as a string of at most 1000 characters.
    const merchantParameters = order.references?.merchantParameters;
    if (merchantParameters !== undefined && !text(1000)(merchantParameters)) {
      return invalid("order.references.merchantParameters", "outside the documented type or limit");
    }
    // The API contract's types and limits on customerDevice and its browserData.
    const device = order.customer?.device;
    if (device !== undefined) {
      if (!isObject(device)) return invalid("order.customer.device", "must be an object");
      const browserData = device["browserData"] === undefined ? {} : device["browserData"];
      if (!isObject(browserData)) return invalid("order.customer.device.browserData", "must be an object");
      const fields: Array<[string, unknown, (value: unknown) => boolean]> = [
        ["acceptHeader", device["acceptHeader"], text(2048)],
        ["ipAddress", device["ipAddress"], text(45)],
        ["locale", device["locale"], text(35)],
        ["timezoneOffsetUtcMinutes", device["timezoneOffsetUtcMinutes"], text(6)],
        ["userAgent", device["userAgent"], text(2048)],
        ["deviceFingerprint", device["deviceFingerprint"], text(1024)],
        ["browserData.colorDepth", browserData["colorDepth"], (value) => typeof value === "number" && Number.isInteger(value) && value <= 99],
        ["browserData.javaEnabled", browserData["javaEnabled"], flag],
        ["browserData.javaScriptEnabled", browserData["javaScriptEnabled"], flag],
        ["browserData.screenHeight", browserData["screenHeight"], text(6)],
        ["browserData.screenWidth", browserData["screenWidth"], text(6)],
      ];
      for (const [field, value, valid] of fields) {
        if (value !== undefined && !valid(value)) return invalid(`order.customer.device.${field}`, "outside the documented type or limit");
      }
    }
    if (this.invalidTokens.has(hostedTokenizationId)) {
      return invalid("hostedTokenizationId", "unknown or expired hosted tokenization");
    }
    const id = `pay_${++this.seq}`;
    const sale = (card.authorizationMode ?? "SALE").toUpperCase() !== "PRE_AUTHORIZATION";
    const merchantReference = order.references?.merchantReference;
    const created = {
      id,
      amount,
      currencyCode,
      merchantReference,
      merchantParameters: merchantParameters as string | undefined,
      transactionDate: contractDateTime(requestedAt),
    };
    const refusedPendingCode = this.refusedWhilePending.get(hostedTokenizationId);
    if (amount === DECLINE_AMOUNT || this.declinedCards.has(hostedTokenizationId) || refusedPendingCode !== undefined) {
      // Documented decline shape: HTTP 402 with errors[] and, in paymentResult,
      // the payment the attempt created, REJECTED unless a lever says otherwise.
      const payment: StoredPayment = {
        ...created,
        ...(refusedPendingCode === undefined
          ? { status: "REJECTED", statusCode: 2, statusCategory: "UNSUCCESSFUL" }
          : pendingAuthorization(refusedPendingCode)),
        sale, capturableRemaining: 0, captures: [], refunds: [],
      };
      this.store(payment);
      return {
        status: 402,
        body: {
          errorId: `err_${++this.seq}`,
          errors: [
            { errorCode: "GENERIC_DECLINE", category: "PAYMENT_PLATFORM_ERROR", httpStatusCode: 402, message: "Payment rejected", retriable: false },
          ],
          status: 402,
          paymentResult: createResponse(payment),
        },
      };
    }
    const pendingCode = this.pendingCards.get(hostedTokenizationId);
    if (pendingCode !== undefined) {
      const payment: StoredPayment = {
        ...created,
        ...pendingAuthorization(pendingCode),
        sale, capturableRemaining: 0, captures: [], refunds: [],
      };
      this.store(payment);
      return { status: 201, body: createResponse(payment) };
    }
    if (this.rejectPayment) {
      const payment: StoredPayment = {
        ...created,
        status: "REJECTED", statusCode: 2, statusCategory: "UNSUCCESSFUL",
        sale, capturableRemaining: 0, captures: [], refunds: [],
        ...(this.rejectPayment.errors ? { errors: this.rejectPayment.errors } : {}),
      };
      this.store(payment);
      return { status: 201, body: createResponse(payment) };
    }
    if (hostedTokenizationId === THREE_DS_TOKEN) {
      const payment: StoredPayment = {
        ...created,
        status: "REDIRECTED", statusCode: 46, statusCategory: "PENDING_CONNECT_OR_3RD_PARTY",
        sale, capturableRemaining: sale ? 0 : amount, captures: [], refunds: [],
      };
      this.store(payment);
      return {
        status: 201,
        body: {
          creationOutput: { tokens: "" },
          merchantAction: {
            actionType: "REDIRECT",
            redirectData: { redirectURL: `https://payment.preprod.direct.worldline-solutions.com/3ds/challenge/${id}` },
          },
          payment: publicPayment(payment),
        },
      };
    }
    const payment: StoredPayment = {
      ...created,
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
    this.store(payment);
    return { status: 201, body: createResponse(payment) };
  }

  private store(payment: StoredPayment): void {
    this.payments.set(payment.id, payment);
    this.uniquePaymentCreations++;
  }

  /**
   * Test helper: a `type` webhook delivery carrying the payment as GetPayment
   * returns it now, in the envelope of the webhooks guide's examples less the
   * merchantId the adapter never reads.
   */
  webhookBody(paymentId: string, type: string): Record<string, unknown> {
    const payment = this.payments.get(paymentId);
    if (!payment) throw new Error(`No payment ${paymentId}`);
    return { apiVersion: "v1", id: `evt_${++this.seq}`, created: new Date(this.clock).toISOString(), type, payment: publicPayment(payment) };
  }

  /** Test helper: the payment the answer stored under an idempotence key reports, if any. */
  paymentIdUnder(idemKey: string): string | undefined {
    const stored = this.createAnswerByIdemKey.get(idemKey);
    if (!stored) return undefined;
    const body = JSON.parse(stored.body) as { payment?: { id?: string }; paymentResult?: { payment?: { id?: string } } };
    return body.payment?.id ?? body.paymentResult?.payment?.id;
  }

  /**
   * Test helper: what became of a 3-D Secure challenge after the redirect, in
   * the Statuses reference's terms: authorised, refused, cancelled, or handed on
   * to an authorisation still pending at that code. A challenge the customer
   * abandons stays at REDIRECTED (46) "indefinitely", which is what leaving it
   * alone models.
   */
  settleChallenge(paymentId: string, outcome: "succeeded" | "rejected" | "cancelled" | PendingAuthorizationCode): void {
    const payment = this.payments.get(paymentId);
    if (!payment || payment.status !== "REDIRECTED") throw new Error(`No open challenge on payment ${paymentId}`);
    if (typeof outcome === "number") {
      Object.assign(payment, pendingAuthorization(outcome));
    } else {
      this.settle(payment, outcome, { errorCode: "40001134", category: "PAYMENT_PLATFORM_ERROR", httpStatusCode: 402, message: "Authentication failed" });
    }
  }

  /**
   * Test helper: the result a pending authorisation (50, 51, 52) ends with.
   * The Statuses reference sends all three on to authorised (5) or refused (2),
   * and 50 and 52 also to captured (9) for a sale; 51 lists 2 and 5 only, so a
   * sale left at 51 ends authorised.
   */
  settlePendingAuthorization(paymentId: string, outcome: "succeeded" | "rejected"): void {
    const payment = this.payments.get(paymentId);
    if (!payment || payment.status !== "AUTHORIZATION_REQUESTED") throw new Error(`No pending authorisation on payment ${paymentId}`);
    const refusal = { errorCode: "30051001", category: "PAYMENT_PLATFORM_ERROR", httpStatusCode: 402, message: "Do not honour" };
    this.settle(payment, outcome, refusal, payment.statusCode !== 51);
  }

  /** `saleCaptures`: whether a sale that goes through is captured (9), or left authorised (5). */
  private settle(
    payment: StoredPayment,
    outcome: "succeeded" | "rejected" | "cancelled",
    refusal: WorldlineApiError,
    saleCaptures = true,
  ): void {
    if (outcome === "rejected") {
      Object.assign(payment, { status: "REJECTED", statusCode: 2, statusCategory: "UNSUCCESSFUL" });
      payment.errors = [refusal];
    } else if (outcome === "cancelled") {
      Object.assign(payment, { status: "CANCELLED", statusCode: 1, statusCategory: "UNSUCCESSFUL", capturableRemaining: 0 });
    } else if (payment.sale && saleCaptures) {
      Object.assign(payment, { status: "CAPTURED", statusCode: 9, statusCategory: "COMPLETED", capturableRemaining: 0 });
      payment.captures.push({
        id: `cap_${++this.seq}`,
        status: "CAPTURED",
        statusOutput: { statusCode: 9, statusCategory: "COMPLETED" },
        captureOutput: { amountOfMoney: { amount: payment.amount, currencyCode: payment.currencyCode } },
      });
    } else {
      Object.assign(payment, { status: "PENDING_CAPTURE", statusCode: 5, statusCategory: "PENDING_MERCHANT", capturableRemaining: payment.amount });
    }
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
    // A sale is closed once created, unless it was left authorised (5), as a
    // sale pending at 51 ends.
    const cancelled = payment.status === "CANCELLED" && payment.statusCode === 6;
    const closedSale = payment.sale && payment.statusCode !== 5;
    if (closedSale || this.hasSettledCapture(payment) || cancelled) {
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
        transactionDate: contractDateTime(this.clock),
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
  const references = {
    ...(payment.merchantReference ? { merchantReference: payment.merchantReference } : {}),
    ...(payment.merchantParameters !== undefined ? { merchantParameters: payment.merchantParameters } : {}),
  };
  return {
    id: payment.id,
    status: payment.status,
    statusOutput: {
      statusCode: payment.statusCode,
      statusCategory: payment.statusCategory,
      ...(payment.errors ? { errors: payment.errors } : {}),
    },
    paymentOutput: {
      amountOfMoney: { amount: payment.amount, currencyCode: payment.currencyCode },
      ...(Object.keys(references).length > 0 ? { references } : {}),
      cardPaymentMethodSpecificOutput: {
        card: { cardNumber: "************4675", expiryDate: "1230" },
        paymentProductId: 1,
      },
      transactionDate: payment.transactionDate,
    },
  };
}

/** Epoch milliseconds as the API contract's transactionDate example writes a date-time: whole seconds, UTC, Z. */
function contractDateTime(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function createResponse(payment: StoredPayment): {
  creationOutput: unknown;
  payment: WorldlinePaymentLike;
} {
  return { creationOutput: { tokens: "" }, payment: publicPayment(payment) };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A string of at most `maxLength` characters. */
function text(maxLength: number): (value: unknown) => boolean {
  return (value) => typeof value === "string" && value.length <= maxLength;
}

function flag(value: unknown): boolean {
  return typeof value === "boolean";
}

function lowercase(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = value;
  return out;
}

function notFound(message = "Unknown entity"): Response {
  return json(404, { errorId: "nf", errors: [{ code: "1", message, httpStatusCode: 404 }] });
}

/** The API Troubleshooting page's "Technical error (Missing/wrong properties)" example. */
function unknownPaymentId(): Response {
  return json(404, {
    errorId: "4dac7acb-70c1-4917-80cd-068833fd8da5",
    errors: [
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
    ],
  });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
