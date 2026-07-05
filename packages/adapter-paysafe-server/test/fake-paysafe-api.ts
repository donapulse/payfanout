import type { PaysafePaymentLike, PaysafeStoredHandleLike } from "../src/index.js";

/**
 * In-memory Paysafe Payments API. Dedupes on merchantRefNum exactly like the
 * real API, so the conformance idempotency test proves the adapter forwards
 * idempotency keys as merchantRefNum.
 */
export class FakePaysafeApi {
  private readonly payments = new Map<string, PaysafePaymentLike>();
  private readonly byRefNum = new Map<string, PaysafePaymentLike>();
  private readonly settlementRefs = new Map<string, object>();
  private readonly refundRefs = new Map<string, object>();
  private readonly refundsById = new Map<string, Record<string, unknown>>();
  /** Customer Vault state: customers + MULTI_USE handles. */
  private readonly customers = new Map<string, { id: string; merchantCustomerId?: string; handles: PaysafeStoredHandleLike[] }>();
  private readonly multiUseTokens = new Set<string>();
  private readonly storedHandleRefs = new Map<string, PaysafeStoredHandleLike>();
  private seq = 0;
  uniquePaymentCreations = 0;
  uniqueRefundCreations = 0;
  uniqueCustomerCreations = 0;
  lastRequestBody: Record<string, unknown> | undefined;

  readonly fetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const parsed = new URL(url);
    const path = parsed.pathname;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    this.lastRequestBody = body;

    if (!(init?.headers as Record<string, string>)?.["authorization"]?.startsWith("Basic ")) {
      return json(401, { error: { code: "5279", message: "Invalid credentials" } });
    }

    if (method === "POST" && path === "/paymenthub/v1/payments") return this.createPayment(body!);
    if (method === "POST" && path === "/paymenthub/v1/customers") {
      const merchantCustomerId = body!["merchantCustomerId"] as string;
      // Real API 409s with 7505 on duplicate merchantCustomerId.
      const existing = [...this.customers.values()].find((c) => c.merchantCustomerId === merchantCustomerId);
      if (existing) {
        return json(409, {
          error: {
            code: "7505",
            message: `The merchantCustomerId provided for this profile has already been used for another profile - ${existing.id}`,
          },
        });
      }
      const customer = { id: `cust_${++this.seq}`, merchantCustomerId, handles: [] };
      this.customers.set(customer.id, customer);
      this.uniqueCustomerCreations++;
      return json(201, { id: customer.id, merchantCustomerId: customer.merchantCustomerId, status: "ACTIVE" });
    }
    if (method === "GET" && path === "/paymenthub/v1/customers" && parsed.searchParams.get("merchantCustomerId")) {
      const wanted = parsed.searchParams.get("merchantCustomerId");
      const found = [...this.customers.values()].find((c) => c.merchantCustomerId === wanted);
      if (!found) return json(404, { error: { code: "5269", message: "No such customer" } });
      return json(200, { id: found.id, merchantCustomerId: found.merchantCustomerId, status: "ACTIVE" });
    }
    const custHandlesMatch = /^\/paymenthub\/v1\/customers\/([^/?]+)\/paymenthandles$/.exec(path);
    if (method === "POST" && custHandlesMatch) {
      const customer = this.customers.get(decodeURIComponent(custHandlesMatch[1]!));
      if (!customer) return json(404, { error: { code: "5269", message: "No such customer" } });
      const refNum = body!["merchantRefNum"] as string;
      const existing = this.storedHandleRefs.get(refNum);
      if (existing) return json(200, existing);
      if (typeof body!["paymentHandleTokenFrom"] !== "string") {
        return json(400, {
          error: { code: "5068", message: "Field error(s)", fieldErrors: [{ field: "paymentHandleTokenFrom", error: "required" }] },
        });
      }
      // Real API 7503s when the card is already vaulted;
      // the special token simulates re-saving a card this customer holds.
      if (body!["paymentHandleTokenFrom"] === "tok_single_use_dupcard" && customer.handles[0]) {
        return json(409, {
          error: {
            code: "7503",
            message: "Card number already in use - some-owner-id",
            details: [`This card is currently associated with Payment Handle Id: ${customer.handles[0].id}`],
          },
        });
      }
      const handle: PaysafeStoredHandleLike = {
        id: `mhdl_${++this.seq}`,
        paymentHandleToken: `MU${++this.seq}tok`,
        merchantRefNum: refNum,
        status: "PAYABLE",
        usage: "MULTI_USE",
        paymentType: "CARD",
        card: { cardType: "VI", lastDigits: "1111" },
      };
      customer.handles.push(handle);
      this.multiUseTokens.add(handle.paymentHandleToken);
      this.storedHandleRefs.set(refNum, handle);
      return json(201, handle);
    }
    const custGetMatch = /^\/paymenthub\/v1\/customers\/([^/?]+)$/.exec(path);
    if (method === "GET" && custGetMatch) {
      const customer = this.customers.get(decodeURIComponent(custGetMatch[1]!));
      if (!customer) return json(404, { error: { code: "5269", message: "No such customer" } });
      const withHandles = parsed.searchParams.get("fields") === "paymenthandles";
      return json(200, {
        id: customer.id,
        merchantCustomerId: customer.merchantCustomerId,
        status: "ACTIVE",
        ...(withHandles ? { paymentHandles: customer.handles } : {}),
      });
    }
    const custHandleDeleteMatch = /^\/paymenthub\/v1\/customers\/([^/?]+)\/paymenthandles\/([^/?]+)$/.exec(path);
    if (method === "DELETE" && custHandleDeleteMatch) {
      const customer = this.customers.get(decodeURIComponent(custHandleDeleteMatch[1]!));
      const handleId = decodeURIComponent(custHandleDeleteMatch[2]!);
      const index = customer?.handles.findIndex((h) => h.id === handleId) ?? -1;
      if (!customer || index === -1) return json(404, { error: { code: "5269", message: "No such payment handle" } });
      this.multiUseTokens.delete(customer.handles[index]!.paymentHandleToken);
      customer.handles.splice(index, 1);
      return new Response("", { status: 200 });
    }
    if (method === "GET" && path === "/paymenthub/v1/settlements") {
      // Real API: settlements are query-only, keyed by merchantRefNum.
      const refNum = parsed.searchParams.get("merchantRefNum");
      if (!refNum) {
        return json(400, {
          error: { code: "5068", message: "Field error(s)", fieldErrors: [{ field: "merchantRefNum", error: "Value is required." }] },
        });
      }
      const settlement = this.settlementRefs.get(refNum);
      return json(200, {
        meta: { numberOfRecords: settlement ? 1 : 0 },
        settlements: settlement ? [settlement] : [],
      });
    }
    const paymentMatch = /^\/paymenthub\/v1\/payments\/([^/]+)$/.exec(path);
    if (method === "GET" && paymentMatch) return this.getPayment(decodeURIComponent(paymentMatch[1]!));
    const refundGetMatch = /^\/paymenthub\/v1\/refunds\/([^/]+)$/.exec(path);
    if (method === "GET" && refundGetMatch) {
      const refund = this.refundsById.get(decodeURIComponent(refundGetMatch[1]!));
      if (!refund) return json(404, { error: { code: "5269", message: "No such refund" } });
      return json(200, refund);
    }
    const settleMatch = /^\/paymenthub\/v1\/payments\/([^/]+)\/settlements$/.exec(path);
    if (method === "POST" && settleMatch) return this.settle(decodeURIComponent(settleMatch[1]!), body!);
    const voidMatch = /^\/paymenthub\/v1\/payments\/([^/]+)\/voidauths$/.exec(path);
    if (method === "POST" && voidMatch) return this.voidAuth(decodeURIComponent(voidMatch[1]!), body!);
    const refundMatch = /^\/paymenthub\/v1\/settlements\/([^/]+)\/refunds$/.exec(path);
    if (method === "POST" && refundMatch) return this.refund(decodeURIComponent(refundMatch[1]!), body!);
    if (method === "POST" && path === "/paymenthub/v1/verifications") {
      if (body!["paymentHandleToken"] === "tok_declined") {
        return json(402, { error: { code: "3022", message: "Insufficient funds" } });
      }
      return json(200, { id: `ver_${++this.seq}`, status: "COMPLETED", txnTime: "2026-07-04T10:00:00Z" });
    }
    return json(404, { error: { code: "5269", message: `No route ${method} ${path}` } });
  };

  private createPayment(body: Record<string, unknown>): Response {
    // Real API strict-parses the body: webhook/returnLinks/shippingDetails are
    // handle-level fields and get rejected here (error 5023).
    for (const field of ["webhook", "returnLinks", "shippingDetails"]) {
      if (field in body) {
        return json(400, {
          error: { code: "5023", message: "Request body not parsable", details: [`field '${field}' not recognized`] },
        });
      }
    }
    const refNum = body["merchantRefNum"] as string;
    if (this.byRefNum.has(refNum)) return json(200, this.publicPayment(this.byRefNum.get(refNum)!));
    const token = body["paymentHandleToken"] as string;
    if (token === "tok_declined") {
      return json(402, { error: { code: "3022", message: "Insufficient funds" } });
    }
    if (!token) return json(400, { error: { code: "5068", message: "Missing paymentHandleToken" } });
    // Deleted/unknown MULTI_USE tokens die exactly like the real API (5068).
    if (token.startsWith("MU") && !this.multiUseTokens.has(token)) {
      return json(400, {
        error: { code: "5068", message: "Field error(s)", fieldErrors: [{ field: "paymentHandleToken", error: "Either invalid or no value provided" }] },
      });
    }
    const settleWithAuth = body["settleWithAuth"] as boolean;
    const amount = body["amount"] as number;
    const payment: PaysafePaymentLike = {
      id: `pay_${++this.seq}`,
      merchantRefNum: refNum,
      status: "COMPLETED",
      amount,
      availableToSettle: settleWithAuth ? 0 : amount,
      currencyCode: body["currencyCode"] as string,
      settleWithAuth,
      txnTime: "2026-07-04T10:00:00Z",
      paymentType: "CARD",
      // Real API echoes masked instrument facts on the payment object (cardType, not type).
      card: { cardType: "VI", lastDigits: "1111" },
      settlements: [],
    };
    if (settleWithAuth) {
      // Real API: auto-capture creates an implicit settlement sharing the
      // payment's merchantRefNum, discoverable only via the settlements query.
      const settlement = {
        id: `stl_${++this.seq}`,
        merchantRefNum: refNum,
        status: "PENDING",
        amount,
        availableToRefund: amount,
        refundedAmount: 0,
        txnTime: "2026-07-04T10:00:01Z",
      };
      payment.settlements = [settlement];
      this.settlementRefs.set(refNum, settlement);
    }
    this.payments.set(payment.id, payment);
    this.byRefNum.set(refNum, payment);
    this.uniquePaymentCreations++;
    return json(200, this.publicPayment(payment));
  }

  /** Real API responses never embed settlements — they must be queried. */
  private publicPayment(payment: PaysafePaymentLike): PaysafePaymentLike {
    return { ...payment, settlements: undefined };
  }

  private getPayment(id: string): Response {
    const payment = this.payments.get(id);
    if (!payment) return json(404, { error: { code: "5269", message: `No such payment ${id}` } });
    return json(200, this.publicPayment(payment));
  }

  private settle(id: string, body: Record<string, unknown>): Response {
    const payment = this.payments.get(id);
    if (!payment) return json(404, { error: { code: "5269", message: "No such payment" } });
    const refNum = body["merchantRefNum"] as string;
    if (this.settlementRefs.has(refNum)) return json(200, this.settlementRefs.get(refNum)!);
    // Real Paysafe rejects settlements without an explicit amount.
    if (typeof body["amount"] !== "number") {
      return json(400, {
        error: { code: "5068", message: "Field error(s)", fieldErrors: [{ field: "amount", error: "must not be null" }] },
      });
    }
    const settleAmount = body["amount"] as number;
    // Real API allows MULTIPLE partial settlements while availableToSettle covers them.
    const remaining = payment.availableToSettle ?? payment.amount ?? 0;
    if (payment.status !== "COMPLETED" || payment.settleWithAuth || settleAmount > remaining) {
      return json(400, { error: { code: "5050", message: "Payment is not in a settleable state" } });
    }
    const settlement = {
      id: `stl_${++this.seq}`,
      merchantRefNum: refNum,
      status: "PENDING",
      amount: settleAmount,
      availableToRefund: settleAmount,
      refundedAmount: 0,
      txnTime: "2026-07-04T10:05:00Z",
    };
    payment.settlements = [...(payment.settlements ?? []), settlement];
    payment.availableToSettle = remaining - settleAmount;
    this.settlementRefs.set(refNum, settlement);
    return json(200, settlement);
  }

  private voidAuth(id: string, body: Record<string, unknown>): Response {
    const payment = this.payments.get(id);
    if (!payment) return json(404, { error: { code: "5269", message: "No such payment" } });
    // Real Paysafe rejects voidauths without an explicit amount.
    if (typeof body["amount"] !== "number") {
      return json(400, {
        error: { code: "5068", message: "Field error(s)", fieldErrors: [{ field: "amount", error: "must not be null" }] },
      });
    }
    const remaining = payment.availableToSettle ?? 0;
    if (payment.settleWithAuth || remaining <= 0 || (body["amount"] as number) > remaining) {
      return json(400, { error: { code: "5050", message: "Nothing voidable on this payment" } });
    }
    // Voiding the remainder AFTER a partial
    // settlement works — settled funds stay settled, payment stays COMPLETED.
    // Only a payment with no settlements at all flips to CANCELLED.
    payment.availableToSettle = remaining - (body["amount"] as number);
    if ((payment.settlements ?? []).length === 0) payment.status = "CANCELLED";
    return json(200, { id: `void_${++this.seq}`, status: "COMPLETED", amount: body["amount"] });
  }

  private refund(settlementId: string, body: Record<string, unknown>): Response {
    const refNum = body["merchantRefNum"] as string;
    if (this.refundRefs.has(refNum)) return json(200, this.refundRefs.get(refNum)!);
    for (const payment of this.payments.values()) {
      const settlement = (payment.settlements ?? []).find((s) => s.id === settlementId);
      if (settlement) {
        const amount = (body["amount"] as number | undefined) ?? (settlement.amount ?? 0) - (settlement.refundedAmount ?? 0);
        if ((settlement.refundedAmount ?? 0) + amount > (settlement.amount ?? 0)) {
          return json(400, { error: { code: "3407", message: "Refund exceeds settled amount" } });
        }
        settlement.refundedAmount = (settlement.refundedAmount ?? 0) + amount;
        settlement.availableToRefund = (settlement.amount ?? 0) - settlement.refundedAmount;
        const refund = {
          id: `ref_${++this.seq}`,
          merchantRefNum: refNum,
          status: "COMPLETED",
          amount,
          txnTime: "2026-07-04T10:10:00Z",
        };
        this.refundRefs.set(refNum, refund);
        this.refundsById.set(refund.id, refund);
        this.uniqueRefundCreations++;
        return json(200, refund);
      }
    }
    return json(404, { error: { code: "5269", message: "No such settlement" } });
  }

  /** Test helper: a refund sitting in an arbitrary status (e.g. PENDING before the batch runs). */
  seedRefund(refund: { id?: string; status: string; amount?: number }): { id: string; status: string; amount: number; txnTime: string } {
    const stored = {
      id: refund.id ?? `ref_${++this.seq}`,
      status: refund.status,
      amount: refund.amount ?? 1000,
      txnTime: "2026-07-04T10:10:00Z",
    };
    this.refundsById.set(stored.id, stored);
    return stored;
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
