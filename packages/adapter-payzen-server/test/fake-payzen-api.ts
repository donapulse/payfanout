/**
 * In-memory PayZen V4 REST gateway. Mirrors the wire behaviors the adapter is
 * built around, verified against the live TEST gateway:
 *   - ALWAYS HTTP 200 — outcomes (including auth failures) ride the
 *     { status: "SUCCESS" | "ERROR", answer } envelope;
 *   - Charge/CreatePayment NEVER dedupes: identical bodies mint new
 *     formTokens every call (PayZen has no idempotency mechanism);
 *   - no transaction exists until the shopper pays — the browser form is
 *     simulated by the payOrder() test hook;
 *   - refunds are new CREDIT transactions and STACK on replay.
 * Transient trouble is injectable only at the transport level
 * (failNextWith: HTTP 5xx/429/network) because the real gateway's business
 * errors never use HTTP statuses.
 */

interface FakeCardDetails {
  effectiveBrand: string;
  pan: string;
  expiryMonth: number;
  expiryYear: number;
  manualValidation: string;
  expectedCaptureDate: string | null;
  captureResponse: { captureDate: string | null; refundAmount: number } | null;
}

export interface FakePayZenTransaction {
  uuid: string;
  amount: number;
  currency: string;
  paymentMethodType: string;
  status: string;
  detailedStatus: string;
  operationType: string;
  creationDate: string;
  errorCode: string | null;
  errorMessage: string | null;
  detailedErrorCode: string | null;
  detailedErrorMessage: string | null;
  metadata: Record<string, string> | null;
  orderDetails: {
    orderId: string;
    orderTotalAmount: number;
    orderEffectiveAmount: number;
    orderCurrency: string;
    mode: string;
    metadata: Record<string, string> | null;
  };
  transactionDetails: {
    creationContext: string;
    parentTransactionUuid: string | null;
    cardDetails: FakeCardDetails;
  };
  _type: string;
}

interface FakeSession {
  orderId: string;
  amount: number;
  currency: string;
  metadata: Record<string, string> | null;
  manualValidation: boolean;
  body: Record<string, unknown>;
}

export class FakePayZenApi {
  // The OFFICIAL public DEMO store credentials from the PayZen documentation
  // (100% public, TEST-only). Using them keeps the deterministic kr-hash
  // vectors — computed against these keys with an independent tool — valid
  // for the very adapter instance the conformance suite runs.
  readonly shopId = "69876357";
  readonly password = "testpassword_DEMOPRIVATEKEY23G4475zXZQ2UA5x7M";
  readonly hmacKey = "38453613e7f44dc58732bad3dca2bca3";
  /** Currencies the fake "shop" has an acceptance agreement for. */
  acceptedCurrencies = new Set(["EUR", "USD", "JPY", "KWD", "TND", "GBP", "CAD"]);

  private readonly sessionsByToken = new Map<string, FakeSession>();
  private readonly sessionsByOrder = new Map<string, FakeSession>();
  private readonly transactions = new Map<string, FakePayZenTransaction>();
  private readonly orderTransactions = new Map<string, string[]>();
  private seq = 0;
  private clockSeq = 0;
  private nextTransport: { status?: number; networkError?: boolean } | undefined;
  private nextEnvelopeError: { answer: Record<string, unknown>; forOperation?: string } | undefined;

  uniqueFormTokenCreations = 0;
  uniqueTransactionCreations = 0;
  uniqueRefundCreations = 0;
  lastRequestBody: Record<string, unknown> | undefined;
  lastOperation: string | undefined;

  /** Injects transport-level trouble into the NEXT call (HTTP status or a network error). */
  failNextWith(failure: { status?: number; networkError?: boolean }): void {
    this.nextTransport = failure;
  }

  /**
   * Makes the NEXT call (optionally: the next call to `forOperation`) answer
   * HTTP 200 + ERROR envelope with this WebServiceError body.
   */
  failNextEnvelope(answer: Record<string, unknown>, forOperation?: string): void {
    this.nextEnvelopeError = { answer, ...(forOperation ? { forOperation } : {}) };
  }

  readonly fetch: typeof fetch = async (input, init) => {
    if (this.nextTransport) {
      const { status, networkError } = this.nextTransport;
      this.nextTransport = undefined;
      if (networkError) throw new TypeError("fetch failed: ECONNRESET");
      return new Response("upstream unavailable", { status: status ?? 503 });
    }
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const operation = /\/V4\/(.+)$/.exec(new URL(url).pathname)?.[1] ?? "";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    this.lastRequestBody = body;
    this.lastOperation = operation;

    const auth = (init?.headers as Record<string, string>)?.["authorization"] ?? "";
    const expected = `Basic ${btoa(`${this.shopId}:${this.password}`)}`;
    if (auth !== expected) {
      // Live-verified verbatim: wrong credentials still answer HTTP 200.
      return this.error(operation, {
        errorCode: "INT_905",
        errorMessage: "invalid login or private key",
        detailedErrorCode: null,
        detailedErrorMessage: null,
        ticket: "null",
        shopId: null,
        _type: "V4/WebService/WebServiceError",
      });
    }
    if (this.nextEnvelopeError && (!this.nextEnvelopeError.forOperation || this.nextEnvelopeError.forOperation === operation)) {
      const { answer } = this.nextEnvelopeError;
      this.nextEnvelopeError = undefined;
      return this.error(operation, answer);
    }

    switch (operation) {
      case "Charge/SDKTest":
        return this.sdkTest(body);
      case "Charge/CreatePayment":
        return this.createPayment(body);
      case "Order/Get":
        return this.orderGet(body);
      case "Transaction/Get":
        return this.transactionGet(body);
      case "Transaction/Validate":
        return this.validate(body);
      case "Transaction/Cancel":
        return this.cancel(body);
      case "Transaction/Refund":
        return this.refund(body);
      case "Transaction/CancelOrRefund":
        return this.cancelOrRefund(body);
      default:
        return this.error(operation, {
          errorCode: "INT_901",
          errorMessage: "web-service not found",
          detailedErrorCode: null,
          detailedErrorMessage: `no web-service found at ${url}`,
          ticket: "null",
          shopId: this.shopId,
          _type: "V4/WebService/WebServiceError",
        });
    }
  };

  // --- Test hooks (stand-ins for the browser form / the capture batch) ------

  /**
   * Simulates the shopper completing the krypton form for the newest session
   * of this orderId — the ONLY way transactions come into existence, exactly
   * like the real platform.
   */
  payOrder(
    orderId: string,
    opts: { status?: "AUTHORISED" | "AUTHORISED_TO_VALIDATE" | "REFUSED"; card?: { brand?: string; pan?: string } } = {},
  ): FakePayZenTransaction {
    const session = this.sessionsByOrder.get(orderId);
    if (!session) throw new Error(`fake: no CreatePayment session for orderId ${orderId}`);
    const detailedStatus = opts.status ?? (session.manualValidation ? "AUTHORISED_TO_VALIDATE" : "AUTHORISED");
    const refused = detailedStatus === "REFUSED";
    const tx: FakePayZenTransaction = {
      uuid: this.nextUuid(),
      amount: session.amount,
      currency: session.currency,
      paymentMethodType: "CARD",
      status: refused ? "UNPAID" : detailedStatus === "AUTHORISED_TO_VALIDATE" ? "RUNNING" : "PAID",
      detailedStatus,
      operationType: "DEBIT",
      creationDate: this.nextDate(),
      errorCode: refused ? "ACQ_001" : null,
      errorMessage: refused ? "payment refused" : null,
      detailedErrorCode: refused ? "51" : null,
      detailedErrorMessage: null,
      metadata: session.metadata,
      orderDetails: {
        orderId,
        orderTotalAmount: session.amount,
        orderEffectiveAmount: session.amount,
        orderCurrency: session.currency,
        mode: "TEST",
        metadata: session.metadata,
      },
      transactionDetails: {
        creationContext: "CHARGE",
        parentTransactionUuid: null,
        cardDetails: {
          effectiveBrand: opts.card?.brand ?? "VISA",
          pan: opts.card?.pan ?? "497010XXXXXX0055",
          expiryMonth: 6,
          expiryYear: 2029,
          manualValidation: session.manualValidation ? "YES" : "NO",
          expectedCaptureDate: refused ? null : "2026-07-08T10:00:00+00:00",
          captureResponse: null,
        },
      },
      _type: "V4/PaymentTransaction",
    };
    this.transactions.set(tx.uuid, tx);
    this.orderTransactions.set(orderId, [...(this.orderTransactions.get(orderId) ?? []), tx.uuid]);
    this.uniqueTransactionCreations++;
    return tx;
  }

  /** Simulates the capture batch: AUTHORISED → CAPTURED with a capture response. */
  settle(uuid: string): FakePayZenTransaction {
    const tx = this.transactions.get(uuid);
    if (!tx) throw new Error(`fake: no transaction ${uuid}`);
    tx.detailedStatus = "CAPTURED";
    tx.status = "PAID";
    tx.transactionDetails.cardDetails.captureResponse = { captureDate: this.nextDate(), refundAmount: 0 };
    return tx;
  }

  getTransaction(uuid: string): FakePayZenTransaction | undefined {
    return this.transactions.get(uuid);
  }

  // --- Endpoints -------------------------------------------------------------

  /**
   * Charge/SDKTest — a side-effect-free connection probe that echoes the
   * submitted value on valid credentials. Auth is validated at the top of
   * fetch, so wrong credentials answer INT_905 before reaching here; transport
   * trouble is drivable via failNextWith (HTTP 5xx/429/network).
   */
  private sdkTest(body: Record<string, unknown>): Response {
    return this.success("Charge/SDKTest", { value: body["value"] ?? null, _type: "V4/Charge/SDKTestResult" });
  }

  private createPayment(body: Record<string, unknown>): Response {
    const amount = body["amount"];
    if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0) {
      return this.error("Charge/CreatePayment", {
        errorCode: "INT_009",
        errorMessage: "invalid amount",
        detailedErrorCode: null,
        detailedErrorMessage: `Invalid input amount [value=${String(amount)}]`,
        ticket: "null",
        shopId: this.shopId,
        _type: "V4/WebService/WebServiceError",
      });
    }
    const currency = String(body["currency"] ?? "");
    if (!this.acceptedCurrencies.has(currency)) {
      // Live-verified verbatim for a currency without an acceptance agreement.
      return this.error("Charge/CreatePayment", {
        errorCode: "PSP_610",
        errorMessage: "No merchant acceptance agreement available",
        detailedErrorCode: "NO_ACCEPTANCE_AGREEMENT_AVAILABLE",
        detailedErrorMessage:
          "No acceptance agreement available, check input parameters (amount, currency, mode, etc.)",
        ticket: "null",
        shopId: this.shopId,
        _type: "V4/WebService/WebServiceError",
      });
    }
    const orderId = String(body["orderId"] ?? `noorder-${this.seq + 1}`);
    const manualValidation =
      (body["transactionOptions"] as { cardOptions?: { manualValidation?: string } } | undefined)?.cardOptions
        ?.manualValidation === "YES";
    const session: FakeSession = {
      orderId,
      amount,
      currency,
      metadata: (body["metadata"] as Record<string, string> | undefined) ?? null,
      manualValidation,
      body,
    };
    // A new formToken EVERY call, identical bodies included (live-verified) —
    // the fake must never dedupe or the adapter's idempotency story would lie.
    const formToken = `ft${++this.seq}DEMOTOKENPAYZEN`;
    this.sessionsByToken.set(formToken, session);
    this.sessionsByOrder.set(orderId, session);
    this.uniqueFormTokenCreations++;
    return this.success("Charge/CreatePayment", { formToken, _type: "V4/Charge/PaymentForm" });
  }

  private transactionGet(body: Record<string, unknown>): Response {
    const tx = this.transactions.get(String(body["uuid"] ?? ""));
    if (!tx) return this.notFound("Transaction/Get");
    return this.success("Transaction/Get", tx);
  }

  private orderGet(body: Record<string, unknown>): Response {
    const orderId = String(body["orderId"] ?? "");
    const uuids = this.orderTransactions.get(orderId) ?? [];
    // Live-verified: an orderId with sessions but no payment attempt is PSP_010.
    if (uuids.length === 0) return this.notFound("Order/Get");
    const transactions = uuids.map((u) => this.transactions.get(u)!);
    return this.success("Order/Get", {
      shopId: this.shopId,
      orderCycle: "CLOSED",
      orderStatus: transactions.some((t) => t.status === "PAID") ? "PAID" : "UNPAID",
      serverDate: this.nextDate(),
      orderDetails: {
        orderId,
        orderTotalAmount: transactions[0]!.orderDetails.orderTotalAmount,
        orderEffectiveAmount: transactions[0]!.orderDetails.orderEffectiveAmount,
        orderCurrency: transactions[0]!.orderDetails.orderCurrency,
        mode: "TEST",
        metadata: transactions[0]!.orderDetails.metadata,
      },
      transactions,
      _type: "V4/OrderTransactions",
    });
  }

  private validate(body: Record<string, unknown>): Response {
    const tx = this.transactions.get(String(body["uuid"] ?? ""));
    if (!tx) return this.notFound("Transaction/Validate");
    if (tx.detailedStatus !== "AUTHORISED_TO_VALIDATE" && tx.detailedStatus !== "WAITING_AUTHORISATION_TO_VALIDATE") {
      return this.error("Transaction/Validate", {
        errorCode: "PSP_503",
        errorMessage: `This action has not been authorized for a transaction with the ${tx.detailedStatus} status`,
        detailedErrorCode: null,
        detailedErrorMessage: null,
        ticket: "null",
        shopId: this.shopId,
        _type: "V4/WebService/WebServiceError",
      });
    }
    tx.detailedStatus = "AUTHORISED";
    tx.status = "PAID";
    return this.success("Transaction/Validate", tx);
  }

  private static readonly CANCELABLE = new Set([
    "AUTHORISED",
    "AUTHORISED_TO_VALIDATE",
    "WAITING_AUTHORISATION",
    "WAITING_AUTHORISATION_TO_VALIDATE",
  ]);

  private cancel(body: Record<string, unknown>): Response {
    const tx = this.transactions.get(String(body["uuid"] ?? ""));
    if (!tx) return this.notFound("Transaction/Cancel");
    if (tx.detailedStatus === "CANCELLED") {
      return this.stateError("Transaction/Cancel", "PSP_105", "Transaction already cancelled");
    }
    if (!FakePayZenApi.CANCELABLE.has(tx.detailedStatus)) {
      return this.stateError("Transaction/Cancel", "PSP_075", "Cancellation impossible, please try a refund");
    }
    tx.detailedStatus = "CANCELLED";
    tx.status = "UNPAID";
    return this.success("Transaction/Cancel", tx);
  }

  private refund(body: Record<string, unknown>): Response {
    const tx = this.transactions.get(String(body["uuid"] ?? ""));
    if (!tx) return this.notFound("Transaction/Refund");
    if (FakePayZenApi.CANCELABLE.has(tx.detailedStatus)) {
      return this.stateError(
        "Transaction/Refund",
        "PSP_076",
        "The refund operation is not yet available, please try to cancel",
      );
    }
    if (tx.detailedStatus !== "CAPTURED") {
      return this.stateError("Transaction/Refund", "PSP_083", "Non-refundable for an unpaid transaction");
    }
    const refunded = tx.transactionDetails.cardDetails.captureResponse?.refundAmount ?? 0;
    const remaining = tx.amount - refunded;
    if (remaining <= 0) {
      return this.stateError("Transaction/Refund", "PSP_104", "Transaction already refunded");
    }
    const amount = (body["amount"] as number | undefined) ?? remaining;
    if (amount > remaining) {
      return this.stateError("Transaction/Refund", "PSP_511", "Refund amount is too high");
    }
    // Every accepted refund creates a NEW CREDIT transaction — replays stack.
    const credit: FakePayZenTransaction = {
      ...tx,
      uuid: this.nextUuid(),
      amount,
      operationType: "CREDIT",
      status: "PAID",
      detailedStatus: "CAPTURED",
      creationDate: this.nextDate(),
      errorCode: null,
      errorMessage: null,
      detailedErrorCode: null,
      detailedErrorMessage: null,
      transactionDetails: {
        creationContext: "REFUND",
        parentTransactionUuid: tx.uuid,
        cardDetails: { ...tx.transactionDetails.cardDetails, captureResponse: null },
      },
    };
    tx.transactionDetails.cardDetails.captureResponse = {
      captureDate: tx.transactionDetails.cardDetails.captureResponse?.captureDate ?? this.nextDate(),
      refundAmount: refunded + amount,
    };
    this.transactions.set(credit.uuid, credit);
    this.orderTransactions.set(tx.orderDetails.orderId, [
      ...(this.orderTransactions.get(tx.orderDetails.orderId) ?? []),
      credit.uuid,
    ]);
    this.uniqueRefundCreations++;
    return this.success("Transaction/Refund", credit);
  }

  private cancelOrRefund(body: Record<string, unknown>): Response {
    const tx = this.transactions.get(String(body["uuid"] ?? ""));
    if (!tx) return this.notFound("Transaction/CancelOrRefund");
    const mode = String(body["resolutionMode"] ?? "AUTO");
    if (mode === "CANCELLATION_ONLY") return this.cancel(body);
    if (mode === "REFUND_ONLY") return this.refund(body);
    return FakePayZenApi.CANCELABLE.has(tx.detailedStatus) ? this.cancel(body) : this.refund(body);
  }

  // --- Envelope plumbing ------------------------------------------------------

  private success(webService: string, answer: unknown): Response {
    return this.respond(webService, "SUCCESS", answer);
  }

  private error(webService: string, answer: Record<string, unknown>): Response {
    return this.respond(webService, "ERROR", {
      ticket: "null",
      shopId: this.shopId,
      _type: "V4/WebService/WebServiceError",
      ...answer,
    });
  }

  private notFound(webService: string): Response {
    // Live-verified verbatim — the same body serves Transaction/Get,
    // Transaction/Refund, Transaction/Cancel, and Order/Get on unknown ids.
    return this.error(webService, {
      errorCode: "PSP_010",
      errorMessage: "transaction not found",
      detailedErrorCode: null,
      detailedErrorMessage: null,
    });
  }

  private stateError(webService: string, errorCode: string, errorMessage: string): Response {
    return this.error(webService, {
      errorCode,
      errorMessage,
      detailedErrorCode: null,
      detailedErrorMessage: null,
    });
  }

  private respond(webService: string, status: "SUCCESS" | "ERROR", answer: unknown): Response {
    return new Response(
      JSON.stringify({
        webService,
        version: "V4",
        applicationVersion: "7.2.2",
        status,
        answer,
        ticket: null,
        serverDate: this.nextDate(),
        applicationProvider: "PAYZEN",
        metadata: null,
        mode: "TEST",
        serverUrl: "https://api.payzen.eu",
        _type: "V4/WebService/Response",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  private nextUuid(): string {
    return (++this.seq).toString(16).padStart(32, "0");
  }

  /** Strictly increasing timestamps in PayZen's UTC offset style. */
  private nextDate(): string {
    const ms = Date.UTC(2026, 6, 7, 10, 0, 0) + this.clockSeq++ * 1000;
    return new Date(ms).toISOString().replace(".000Z", "+00:00");
  }
}
