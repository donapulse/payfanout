import type {
  StripeClientLike,
  StripeCustomerLike,
  StripeEventLike,
  StripeListLike,
  StripePaymentIntentLike,
  StripePaymentMethodLike,
  StripePriceLike,
  StripeProductLike,
  StripeRefundLike,
  StripeRequestOptions,
  StripeSetupIntentLike,
  StripeSubscriptionLike,
} from "../src/index.js";

/** Plain-object Stripe-style error, matching the SDK's structural shape. */
export function stripeError(init: {
  type: string;
  message: string;
  code?: string;
  decline_code?: string;
  statusCode?: number;
}): object {
  return { ...init };
}

/**
 * In-memory Stripe mock. Implements idempotency the way Stripe does (same key
 * -> same object, no duplicate side effect) so the conformance suite can prove
 * the adapter actually forwards idempotency keys.
 */
export class FakeStripe implements StripeClientLike {
  private readonly intents = new Map<string, StripePaymentIntentLike>();
  private readonly setis = new Map<string, StripeSetupIntentLike>();
  private readonly storedRefunds = new Map<string, StripeRefundLike>();
  private readonly storedEvents: StripeEventLike[] = [];
  private readonly storedCustomers = new Map<string, StripeCustomerLike>();
  private readonly storedPaymentMethods = new Map<string, StripePaymentMethodLike>();
  private readonly storedSubscriptions = new Map<string, StripeSubscriptionLike>();
  private readonly storedPrices = new Map<string, StripePriceLike>();
  private readonly storedProducts = new Map<string, StripeProductLike>();
  private readonly idempotentCreates = new Map<string, StripePaymentIntentLike>();
  private readonly idempotentRefunds = new Map<string, StripeRefundLike>();
  private readonly idempotentSubscriptions = new Map<string, StripeSubscriptionLike>();
  private readonly idempotentProducts = new Map<string, StripeProductLike>();
  private seq = 0;
  uniquePaymentIntentCreations = 0;
  uniqueRefundCreations = 0;
  uniqueSubscriptionCreations = 0;
  uniqueProductCreations = 0;
  readonly detachedPaymentMethods: string[] = [];
  /** Params of every customers.listPaymentMethods call — for pagination assertions. */
  readonly listPaymentMethodsCalls: Array<Record<string, unknown> | undefined> = [];
  /** Params of the last paymentIntents.create/update call — for mapping assertions. */
  lastPaymentIntentParams: Record<string, unknown> | undefined;
  /** Params of the last setupIntents.create call — for mapping assertions. */
  lastSetupIntentParams: Record<string, unknown> | undefined;
  /** Params of the last subscriptions.create call — for mapping assertions. */
  lastSubscriptionParams: Record<string, unknown> | undefined;
  /** Params of the last products.create call — for mapping assertions. */
  lastProductParams: Record<string, unknown> | undefined;
  private nextError: object | undefined;

  failNextWith(err: object): void {
    this.nextError = err;
  }

  private throwPending(): void {
    if (this.nextError) {
      const err = this.nextError;
      this.nextError = undefined;
      throw err;
    }
  }

  private notFound(kind: string, id: string): never {
    throw stripeError({
      type: "StripeInvalidRequestError",
      statusCode: 404,
      message: `No such ${kind}: '${id}'`,
    });
  }

  paymentIntents = {
    create: async (params: Record<string, unknown>, opts?: StripeRequestOptions): Promise<StripePaymentIntentLike> => {
      this.throwPending();
      this.lastPaymentIntentParams = params;
      if (opts?.idempotencyKey && this.idempotentCreates.has(opts.idempotencyKey)) {
        return this.idempotentCreates.get(opts.idempotencyKey)!;
      }
      const pi: StripePaymentIntentLike = {
        id: `pi_${++this.seq}`,
        object: "payment_intent",
        status: "requires_payment_method",
        amount: params["amount"] as number,
        amount_received: 0,
        amount_capturable: 0,
        currency: params["currency"] as string,
        created: 1_780_000_000,
        client_secret: `pi_${this.seq}_secret_test`,
        metadata: (params["metadata"] as Record<string, string>) ?? {},
        latest_charge: null,
        payment_method_types: (params["payment_method_types"] as string[]) ?? ["card"],
        ...(typeof params["setup_future_usage"] === "string"
          ? { setup_future_usage: params["setup_future_usage"] as string }
          : {}),
      };
      (pi as unknown as Record<string, unknown>)["capture_method"] = params["capture_method"];
      (pi as unknown as Record<string, unknown>)["customer"] = params["customer"];
      this.intents.set(pi.id, pi);
      this.uniquePaymentIntentCreations++;
      if (opts?.idempotencyKey) this.idempotentCreates.set(opts.idempotencyKey, pi);

      // Server-side confirm with a stored instrument (off-session/MIT path):
      // like real Stripe, the PI resolves terminally within the create call.
      if (params["confirm"] === true) {
        const pmId = params["payment_method"] as string | undefined;
        const pm = pmId ? this.storedPaymentMethods.get(pmId) : undefined;
        if (!pm) this.notFound("payment_method", String(pmId));
        const owner = typeof pm.customer === "string" ? pm.customer : pm.customer?.id;
        if (!owner || owner !== params["customer"]) {
          throw stripeError({
            type: "StripeInvalidRequestError",
            statusCode: 400,
            message: "The payment method must be attached to the customer to confirm off-session",
          });
        }
        if ((pm as unknown as Record<string, unknown>)["__behavior"] === "auth_required") {
          throw stripeError({
            type: "StripeCardError",
            statusCode: 402,
            code: "authentication_required",
            decline_code: "authentication_required",
            message: "This payment requires authentication.",
          });
        }
        if ((pm as unknown as Record<string, unknown>)["__behavior"] === "declined") {
          throw stripeError({
            type: "StripeCardError",
            statusCode: 402,
            code: "card_declined",
            decline_code: "insufficient_funds",
            message: "Your card has insufficient funds.",
          });
        }
        pi.status = "succeeded";
        pi.amount_received = pi.amount;
        pi.latest_charge = {
          id: `ch_${++this.seq}`,
          amount_refunded: 0,
          refunded: false,
          captured: true,
          created: 1_780_000_150,
          payment_method: pm.id,
          payment_method_details: {
            type: "card",
            card: {
              brand: pm.card?.brand ?? "visa",
              last4: pm.card?.last4 ?? "4242",
              ...(pm.card?.exp_month ? { exp_month: pm.card.exp_month } : {}),
              ...(pm.card?.exp_year ? { exp_year: pm.card.exp_year } : {}),
            },
          },
        };
      }
      return pi;
    },
    retrieve: async (id: string): Promise<StripePaymentIntentLike> => {
      this.throwPending();
      const pi = this.intents.get(id);
      if (!pi) this.notFound("payment_intent", id);
      return pi;
    },
    update: async (id: string, params: Record<string, unknown>): Promise<StripePaymentIntentLike> => {
      this.throwPending();
      this.lastPaymentIntentParams = params;
      const pi = this.intents.get(id);
      if (!pi) this.notFound("payment_intent", id);
      if (pi.status !== "requires_payment_method" && pi.status !== "requires_confirmation") {
        throw stripeError({
          type: "StripeInvalidRequestError",
          statusCode: 400,
          message: `PaymentIntent ${id} cannot be updated in status ${pi.status}`,
        });
      }
      if (typeof params["amount"] === "number") pi.amount = params["amount"];
      if (typeof params["currency"] === "string") pi.currency = params["currency"];
      if (params["metadata"]) pi.metadata = { ...pi.metadata, ...(params["metadata"] as Record<string, string>) };
      return pi;
    },
    list: async (params?: Record<string, unknown>): Promise<StripeListLike<StripePaymentIntentLike>> => {
      this.throwPending();
      return paginate([...this.intents.values()].reverse(), params, (pi) => pi.id, (pi) => pi.created);
    },
    capture: async (id: string, params?: Record<string, unknown>): Promise<StripePaymentIntentLike> => {
      this.throwPending();
      const pi = this.intents.get(id);
      if (!pi) this.notFound("payment_intent", id);
      if (pi.status !== "requires_capture") {
        throw stripeError({
          type: "StripeInvalidRequestError",
          statusCode: 400,
          message: `PaymentIntent ${id} is not capturable (status: ${pi.status})`,
        });
      }
      const captureAmount = (params?.["amount_to_capture"] as number | undefined) ?? pi.amount;
      if (captureAmount > (pi.amount_capturable ?? pi.amount)) {
        throw stripeError({
          type: "StripeInvalidRequestError",
          statusCode: 400,
          message: `Amount to capture (${captureAmount}) is greater than the amount authorized (${pi.amount_capturable ?? pi.amount})`,
        });
      }
      pi.status = "succeeded";
      // Real Stripe semantics: `amount` stays at the authorized value; the
      // collected funds land in amount_received and nothing stays capturable
      // (single capture releases the remainder of the authorization).
      pi.amount_received = captureAmount;
      pi.amount_capturable = 0;
      if (typeof pi.latest_charge === "object" && pi.latest_charge) pi.latest_charge.captured = true;
      return pi;
    },
    cancel: async (id: string): Promise<StripePaymentIntentLike> => {
      this.throwPending();
      const pi = this.intents.get(id);
      if (!pi) this.notFound("payment_intent", id);
      if (pi.status === "succeeded" || pi.status === "canceled") {
        throw stripeError({
          type: "StripeInvalidRequestError",
          statusCode: 400,
          message: `You cannot cancel this PaymentIntent because it has a status of ${pi.status}.`,
        });
      }
      pi.status = "canceled";
      pi.amount_capturable = 0;
      return pi;
    },
  };

  setupIntents = {
    create: async (params: Record<string, unknown>, opts?: StripeRequestOptions): Promise<StripeSetupIntentLike> => {
      this.throwPending();
      void opts;
      this.lastSetupIntentParams = params;
      const seti: StripeSetupIntentLike = {
        id: `seti_${++this.seq}`,
        object: "setup_intent",
        status: "requires_payment_method",
        created: 1_780_000_000,
        client_secret: `seti_${this.seq}_secret_test`,
        metadata: (params["metadata"] as Record<string, string>) ?? {},
        payment_method: null,
        ...(typeof params["customer"] === "string" ? { customer: params["customer"] as string } : {}),
      };
      this.setis.set(seti.id, seti);
      return seti;
    },
    retrieve: async (id: string): Promise<StripeSetupIntentLike> => {
      this.throwPending();
      const seti = this.setis.get(id);
      if (!seti) this.notFound("setup_intent", id);
      return seti;
    },
  };

  paymentMethods = {
    retrieve: async (id: string): Promise<StripePaymentMethodLike> => {
      this.throwPending();
      const pm = this.storedPaymentMethods.get(id);
      if (!pm) this.notFound("payment_method", id);
      return pm;
    },
    detach: async (id: string): Promise<unknown> => {
      this.throwPending();
      this.detachedPaymentMethods.push(id);
      const pm = this.storedPaymentMethods.get(id);
      if (pm) pm.customer = null;
      return { id, customer: null };
    },
  };

  customers = {
    create: async (params: Record<string, unknown>, opts?: StripeRequestOptions): Promise<StripeCustomerLike> => {
      this.throwPending();
      void opts;
      const customer: StripeCustomerLike = {
        id: `cus_${++this.seq}`,
        email: (params["email"] as string) ?? null,
        name: (params["name"] as string) ?? null,
        metadata: (params["metadata"] as Record<string, string>) ?? {},
      };
      this.storedCustomers.set(customer.id, customer);
      this.uniqueCustomerCreations++;
      return customer;
    },
    listPaymentMethods: async (
      id: string,
      params?: Record<string, unknown>,
    ): Promise<StripeListLike<StripePaymentMethodLike>> => {
      this.throwPending();
      this.listPaymentMethodsCalls.push(params);
      if (!this.storedCustomers.has(id)) this.notFound("customer", id);
      const attached = [...this.storedPaymentMethods.values()].filter((pm) => {
        const owner = typeof pm.customer === "string" ? pm.customer : pm.customer?.id;
        return owner === id;
      });
      // Real pagination semantics so >100-method customers exercise the
      // adapter's has_more/starting_after loop.
      return paginate(attached, params, (pm) => pm.id, (pm) => pm.created ?? 0);
    },
  };

  uniqueCustomerCreations = 0;

  /** Test helper: a vaulted PaymentMethod attached to a customer. */
  seedPaymentMethod(
    customerId: string | null,
    opts: {
      id?: string;
      brand?: string;
      last4?: string;
      expMonth?: number;
      expYear?: number;
      behavior?: "ok" | "auth_required" | "declined";
    } = {},
  ): StripePaymentMethodLike {
    const pm: StripePaymentMethodLike = {
      id: opts.id ?? `pm_${++this.seq}`,
      type: "card",
      customer: customerId,
      created: 1_780_000_120,
      card: {
        brand: opts.brand ?? "visa",
        last4: opts.last4 ?? "4242",
        exp_month: opts.expMonth ?? 12,
        exp_year: opts.expYear ?? 2030,
      },
    };
    if (opts.behavior && opts.behavior !== "ok") {
      (pm as unknown as Record<string, unknown>)["__behavior"] = opts.behavior;
    }
    this.storedPaymentMethods.set(pm.id, pm);
    return pm;
  }

  refunds = {
    create: async (params: Record<string, unknown>, opts?: StripeRequestOptions): Promise<StripeRefundLike> => {
      this.throwPending();
      if (opts?.idempotencyKey && this.idempotentRefunds.has(opts.idempotencyKey)) {
        return this.idempotentRefunds.get(opts.idempotencyKey)!;
      }
      const pi = this.intents.get(params["payment_intent"] as string);
      if (!pi) this.notFound("payment_intent", String(params["payment_intent"]));
      const charge = typeof pi.latest_charge === "object" && pi.latest_charge ? pi.latest_charge : undefined;
      if (!charge || pi.status !== "succeeded") {
        throw stripeError({
          type: "StripeInvalidRequestError",
          statusCode: 400,
          message: "Charge has not been captured or does not exist",
        });
      }
      const collected = pi.amount_received && pi.amount_received > 0 ? pi.amount_received : pi.amount;
      const unrefunded = collected - (charge.amount_refunded ?? 0);
      const amount = (params["amount"] as number | undefined) ?? unrefunded;
      // Real Stripe rejects refunding more than what remains on the charge.
      if (amount > unrefunded) {
        throw stripeError({
          type: "StripeInvalidRequestError",
          statusCode: 400,
          message: `Refund amount (${amount}) is greater than unrefunded amount on charge (${unrefunded})`,
        });
      }
      charge.amount_refunded = (charge.amount_refunded ?? 0) + amount;
      charge.refunded = charge.amount_refunded >= collected;
      const refund: StripeRefundLike = {
        id: `re_${++this.seq}`,
        amount,
        status: "succeeded",
        payment_intent: pi.id,
        created: 1_780_000_200,
      };
      this.storedRefunds.set(refund.id, refund);
      this.uniqueRefundCreations++;
      if (opts?.idempotencyKey) this.idempotentRefunds.set(opts.idempotencyKey, refund);
      return refund;
    },
    retrieve: async (id: string): Promise<StripeRefundLike> => {
      this.throwPending();
      const refund = this.storedRefunds.get(id);
      if (!refund) this.notFound("refund", id);
      return refund;
    },
    list: async (params?: Record<string, unknown>): Promise<StripeListLike<StripeRefundLike>> => {
      this.throwPending();
      let refunds = [...this.storedRefunds.values()].reverse();
      const paymentIntent = params?.["payment_intent"];
      if (typeof paymentIntent === "string") {
        refunds = refunds.filter((r) => r.payment_intent === paymentIntent);
      }
      return paginate(refunds, params, (r) => r.id, (r) => r.created ?? 0);
    },
  };

  products = {
    create: async (params: Record<string, unknown>, opts?: StripeRequestOptions): Promise<StripeProductLike> => {
      this.throwPending();
      this.lastProductParams = params;
      if (opts?.idempotencyKey && this.idempotentProducts.has(opts.idempotencyKey)) {
        return this.idempotentProducts.get(opts.idempotencyKey)!;
      }
      if (typeof params["name"] !== "string" || params["name"].length === 0) {
        throw stripeError({
          type: "StripeInvalidRequestError",
          statusCode: 400,
          message: "Missing required param: name.",
        });
      }
      const product: StripeProductLike = { id: `prod_${++this.seq}`, name: params["name"] };
      this.storedProducts.set(product.id, product);
      this.uniqueProductCreations++;
      if (opts?.idempotencyKey) this.idempotentProducts.set(opts.idempotencyKey, product);
      return product;
    },
  };

  subscriptions = {
    create: async (params: Record<string, unknown>, opts?: StripeRequestOptions): Promise<StripeSubscriptionLike> => {
      this.throwPending();
      this.lastSubscriptionParams = params;
      if (opts?.idempotencyKey && this.idempotentSubscriptions.has(opts.idempotencyKey)) {
        return this.idempotentSubscriptions.get(opts.idempotencyKey)!;
      }
      const customerId = params["customer"] as string | undefined;
      if (!customerId || !this.storedCustomers.has(customerId)) this.notFound("customer", String(customerId));
      const items = params["items"] as Array<Record<string, unknown>> | undefined;
      const firstItem = items?.[0];
      if (!firstItem) {
        throw stripeError({
          type: "StripeInvalidRequestError",
          statusCode: 400,
          message: "Missing required param: items.",
        });
      }
      let price: StripePriceLike;
      if (typeof firstItem["price"] === "string") {
        const existing = this.storedPrices.get(firstItem["price"]);
        if (!existing) this.notFound("price", firstItem["price"]);
        price = existing;
      } else {
        // Real Stripe requires an EXISTING product id inside price_data —
        // subscription items accept no inline product_data.
        const priceData = firstItem["price_data"] as Record<string, unknown> | undefined;
        const productId = priceData?.["product"];
        if (typeof productId !== "string") {
          throw stripeError({
            type: "StripeInvalidRequestError",
            statusCode: 400,
            message: "Missing required param: items[0][price_data][product].",
          });
        }
        if (!this.storedProducts.has(productId)) this.notFound("product", productId);
        const recurring = priceData?.["recurring"] as Record<string, unknown> | undefined;
        if (typeof recurring?.["interval"] !== "string") {
          throw stripeError({
            type: "StripeInvalidRequestError",
            statusCode: 400,
            message: "Missing required param: items[0][price_data][recurring][interval].",
          });
        }
        price = {
          id: `price_${++this.seq}`,
          currency: priceData?.["currency"] as string,
          unit_amount: priceData?.["unit_amount"] as number,
          recurring: {
            interval: recurring["interval"],
            ...(typeof recurring["interval_count"] === "number"
              ? { interval_count: recurring["interval_count"] }
              : {}),
          },
        };
        this.storedPrices.set(price.id, price);
      }
      const pmId = params["default_payment_method"] as string | undefined;
      const pm = pmId ? this.storedPaymentMethods.get(pmId) : undefined;
      if (!pm) this.notFound("payment_method", String(pmId));
      const owner = typeof pm.customer === "string" ? pm.customer : pm.customer?.id;
      if (owner !== customerId) {
        throw stripeError({
          type: "StripeInvalidRequestError",
          statusCode: 400,
          message: "The default payment method must be attached to the customer.",
        });
      }
      // A future billing_cycle_anchor with proration "none" invoices nothing
      // at creation — only an immediate first invoice can fail the create
      // under payment_behavior error_if_incomplete.
      const anchor = params["billing_cycle_anchor"] as number | undefined;
      const invoicedNow = anchor === undefined;
      if (invoicedNow && params["payment_behavior"] === "error_if_incomplete") {
        if ((pm as unknown as Record<string, unknown>)["__behavior"] === "auth_required") {
          throw stripeError({
            type: "StripeCardError",
            statusCode: 402,
            code: "authentication_required",
            decline_code: "authentication_required",
            message: "This payment requires authentication.",
          });
        }
        if ((pm as unknown as Record<string, unknown>)["__behavior"] === "declined") {
          throw stripeError({
            type: "StripeCardError",
            statusCode: 402,
            code: "card_declined",
            decline_code: "insufficient_funds",
            message: "Your card has insufficient funds.",
          });
        }
      }
      const created = 1_780_000_000 + this.seq;
      const sub: StripeSubscriptionLike = {
        id: `sub_${++this.seq}`,
        object: "subscription",
        status: "active",
        currency: price.currency,
        customer: customerId,
        default_payment_method: pm.id,
        items: { data: [{ id: `si_${++this.seq}`, price, quantity: 1 }] },
        metadata: (params["metadata"] as Record<string, string>) ?? {},
        created,
        canceled_at: null,
        // Pinned-version (2024-06-20) shape: the billing period lives on the
        // subscription itself; basil-shaped records come from seedSubscription.
        current_period_start: created,
        current_period_end: anchor ?? created + 2_592_000,
      };
      this.storedSubscriptions.set(sub.id, sub);
      this.uniqueSubscriptionCreations++;
      if (opts?.idempotencyKey) this.idempotentSubscriptions.set(opts.idempotencyKey, sub);
      return sub;
    },
    retrieve: async (id: string): Promise<StripeSubscriptionLike> => {
      this.throwPending();
      const sub = this.storedSubscriptions.get(id);
      if (!sub) this.notFound("subscription", id);
      return sub;
    },
    list: async (params?: Record<string, unknown>): Promise<StripeListLike<StripeSubscriptionLike>> => {
      this.throwPending();
      let subs = [...this.storedSubscriptions.values()].reverse();
      const status = params?.["status"];
      // Real default: everything that has NOT been canceled.
      if (status === undefined) subs = subs.filter((s) => s.status !== "canceled");
      else if (status !== "all") subs = subs.filter((s) => s.status === status);
      return paginate(subs, params, (s) => s.id, (s) => s.created);
    },
    cancel: async (id: string): Promise<StripeSubscriptionLike> => {
      this.throwPending();
      const sub = this.storedSubscriptions.get(id);
      if (!sub) this.notFound("subscription", id);
      if (sub.status === "canceled") {
        throw stripeError({
          type: "StripeInvalidRequestError",
          statusCode: 400,
          message: `Subscription ${id} is already canceled and cannot be canceled again.`,
        });
      }
      sub.status = "canceled";
      sub.canceled_at = 1_780_000_400;
      return sub;
    },
  };

  /** Test helper: a customer the fixtures can reference synchronously. */
  seedCustomer(id?: string): StripeCustomerLike {
    const customer: StripeCustomerLike = { id: id ?? `cus_${++this.seq}`, email: null, name: null, metadata: {} };
    this.storedCustomers.set(customer.id, customer);
    return customer;
  }

  /** Test helper: an existing recurring Price (the planId path). */
  seedPrice(
    opts: {
      id?: string;
      currency?: string;
      unitAmount?: number | null;
      interval?: string;
      intervalCount?: number;
      usageType?: string;
    } = {},
  ): StripePriceLike {
    const price: StripePriceLike = {
      id: opts.id ?? `price_${++this.seq}`,
      currency: opts.currency ?? "usd",
      unit_amount: opts.unitAmount === undefined ? 1000 : opts.unitAmount,
      recurring: {
        interval: opts.interval ?? "month",
        ...(opts.intervalCount !== undefined ? { interval_count: opts.intervalCount } : {}),
        ...(opts.usageType !== undefined ? { usage_type: opts.usageType } : {}),
      },
    };
    this.storedPrices.set(price.id, price);
    return price;
  }

  /** Test helper: a stored subscription in an arbitrary shape (statuses, basil item-level periods, multi-item). */
  seedSubscription(
    opts: {
      status?: string;
      currency?: string;
      customer?: string;
      defaultPaymentMethod?: string | null;
      metadata?: Record<string, string>;
      items?: Array<{ price: StripePriceLike; quantity?: number | null }>;
      /** Basil-and-later shape: periods on the items, none on the subscription. */
      periodsOnItems?: boolean;
      created?: number;
    } = {},
  ): StripeSubscriptionLike {
    const created = opts.created ?? 1_780_000_000 + this.seq;
    const itemInputs = opts.items ?? [{ price: this.seedPrice() }];
    const periodFields = { current_period_start: created, current_period_end: created + 2_592_000 };
    const sub: StripeSubscriptionLike = {
      id: `sub_${++this.seq}`,
      object: "subscription",
      status: opts.status ?? "active",
      currency: opts.currency ?? "usd",
      customer: opts.customer ?? `cus_${++this.seq}`,
      default_payment_method: opts.defaultPaymentMethod === undefined ? `pm_${++this.seq}` : opts.defaultPaymentMethod,
      items: {
        data: itemInputs.map((item) => ({
          id: `si_${++this.seq}`,
          price: item.price,
          quantity: item.quantity === undefined ? 1 : item.quantity,
          ...(opts.periodsOnItems ? periodFields : {}),
        })),
      },
      metadata: opts.metadata ?? {},
      created,
      canceled_at: opts.status === "canceled" ? created + 100 : null,
      ...(opts.periodsOnItems ? {} : periodFields),
    };
    this.storedSubscriptions.set(sub.id, sub);
    return sub;
  }

  events = {
    list: async (params?: Record<string, unknown>): Promise<StripeListLike<StripeEventLike>> => {
      this.throwPending();
      return paginate([...this.storedEvents].reverse(), params, (e) => e.id, (e) => e.created ?? 0);
    },
  };

  /** Test helper: seeds an event the way Stripe's Events API would report it. */
  seedEvent(type: string, object: Record<string, unknown>, created = 1_780_000_300): StripeEventLike {
    const event: StripeEventLike = { id: `evt_${++this.seq}`, type, created, data: { object } };
    this.storedEvents.push(event);
    return event;
  }

  /** Test helper: a stored refund in an arbitrary status (e.g. an async "pending" refund). */
  seedRefund(refund: Partial<StripeRefundLike> & Pick<StripeRefundLike, "status">): StripeRefundLike {
    const stored: StripeRefundLike = {
      id: refund.id ?? `re_${++this.seq}`,
      amount: refund.amount ?? 1000,
      status: refund.status,
      payment_intent: refund.payment_intent ?? null,
      created: refund.created ?? 1_780_000_200,
    };
    this.storedRefunds.set(stored.id, stored);
    return stored;
  }

  /** Test helper: what the client-side confirm() would do against real Stripe. */
  simulateClientConfirm(
    piId: string,
    opts: {
      paymentMethodType?: string;
      card?: { brand?: string; last4?: string; wallet?: { type?: string }; exp_month?: number; exp_year?: number };
      /** Debit rails (sepa_debit, us_bank_account, …) report a mandate id. */
      mandate?: string;
    } = {},
  ): void {
    const pi = this.intents.get(piId);
    if (!pi) throw new Error(`no such pi ${piId}`);
    const manual = (pi as unknown as Record<string, unknown>)["capture_method"] === "manual";
    const type = opts.paymentMethodType ?? "card";
    pi.status = manual ? "requires_capture" : "succeeded";
    pi.amount_received = manual ? 0 : pi.amount;
    pi.amount_capturable = manual ? pi.amount : 0;
    // Save-during-checkout: customer + setup_future_usage vaults the instrument,
    // exactly like real Stripe attaches the PaymentMethod on confirmation.
    const customer = (pi as unknown as Record<string, unknown>)["customer"] as string | undefined;
    let vaultedPm: StripePaymentMethodLike | undefined;
    if (customer && pi.setup_future_usage) {
      const card = opts.card ?? { brand: "visa", last4: "4242" };
      vaultedPm = this.seedPaymentMethod(customer, { brand: card.brand, last4: card.last4 });
    }
    pi.latest_charge = {
      id: `ch_${++this.seq}`,
      amount_refunded: 0,
      refunded: false,
      captured: !manual,
      created: 1_780_000_100,
      ...(vaultedPm ? { payment_method: vaultedPm.id } : {}),
      payment_method_details: {
        type,
        ...(type === "card" ? { card: opts.card ?? { brand: "visa", last4: "4242" } } : {}),
        ...(opts.mandate ? { [type]: { mandate: opts.mandate } } : {}),
      },
    };
  }

  /** Test helper: confirms a SetupIntent; save-mode setis (customer) vault the PaymentMethod. */
  simulateSetupConfirm(setiId: string): StripePaymentMethodLike {
    const seti = this.setis.get(setiId);
    if (!seti) throw new Error(`no such seti ${setiId}`);
    const customer = typeof seti.customer === "string" ? seti.customer : seti.customer?.id;
    const pm = this.seedPaymentMethod(customer ?? null);
    seti.status = "succeeded";
    seti.payment_method = pm.id;
    return pm;
  }

  /** Test helper: a confirmed SetupIntent with an attached PaymentMethod. */
  seedSetupIntent(status: StripeSetupIntentLike["status"], paymentMethod: string | null): string {
    const id = `seti_${++this.seq}`;
    this.setis.set(id, {
      id,
      object: "setup_intent",
      status,
      created: 1_780_000_000,
      client_secret: `${id}_secret_test`,
      metadata: {},
      payment_method: paymentMethod,
      ...(status === "canceled" && paymentMethod ? { last_setup_error: { code: "setup_failed" } } : {}),
    });
    return id;
  }
}

/** Stripe-style cursor pagination: newest-first, starting_after skips past the cursor. */
function paginate<T>(
  items: T[],
  params: Record<string, unknown> | undefined,
  idOf: (item: T) => string,
  createdOf: (item: T) => number,
): StripeListLike<T> {
  let filtered = items;
  const created = params?.["created"] as { gte?: number; lte?: number } | undefined;
  if (created?.gte !== undefined) filtered = filtered.filter((i) => createdOf(i) >= created.gte!);
  if (created?.lte !== undefined) filtered = filtered.filter((i) => createdOf(i) <= created.lte!);
  const startingAfter = params?.["starting_after"];
  if (typeof startingAfter === "string") {
    const index = filtered.findIndex((i) => idOf(i) === startingAfter);
    filtered = index === -1 ? [] : filtered.slice(index + 1);
  }
  const limit = typeof params?.["limit"] === "number" ? (params["limit"] as number) : 10;
  return { data: filtered.slice(0, limit), has_more: filtered.length > limit };
}
