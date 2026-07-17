import {
  normalizeCurrency,
  PayFanoutError,
  type NativeSubscriptionInterval,
  type NativeSubscriptionRecord,
  type NativeSubscriptionStatus,
} from "@payfanout/core";
import { PAYPAL_PSP_NAME } from "./error-map.js";
import { fromPayPalValue } from "./money.js";

/**
 * The reason sent with every POST /v1/billing/subscriptions/{id}/cancel: the
 * Subscriptions v1 cancel schema REQUIRES `reason` (1–128 chars), and the
 * unified CancelNativeSubscriptionInput carries none — so a fixed, factual
 * default rides along.
 */
export const PAYPAL_SUBSCRIPTION_CANCEL_REASON = "Canceled by merchant";

/** Structural shapes of the Subscriptions v1 responses the adapter reads. */
export interface PayPalSubscriptionMoney {
  currency_code?: string;
  value?: string;
}

export interface PayPalBillingCycleLike {
  /** Absent on free-trial cycles; carries fixed_price for fixed pricing, tiers otherwise. */
  pricing_scheme?: { fixed_price?: PayPalSubscriptionMoney; tiers?: unknown[] };
  frequency?: { interval_unit?: string; interval_count?: number };
  /** "TRIAL" | "REGULAR" */
  tenure_type?: string;
  sequence?: number;
  total_cycles?: number;
}

export interface PayPalSubscriptionLike {
  id?: string;
  status?: string;
  plan_id?: string;
  /** "The custom id for the subscription. Can be invoice id." */
  custom_id?: string;
  quantity?: string;
  start_time?: string;
  create_time?: string;
  update_time?: string;
  subscriber?: {
    email_address?: string;
    payer_id?: string;
    name?: { given_name?: string; surname?: string };
    phone?: { phone_number?: { national_number?: string } };
    payment_source?: { card?: { attributes?: { vault?: { id?: string } } } };
  };
  billing_info?: {
    outstanding_balance?: PayPalSubscriptionMoney;
    last_payment?: { amount?: PayPalSubscriptionMoney; time?: string };
    next_billing_time?: string;
    final_payment_time?: string;
    failed_payments_count?: number;
  };
  /** The effective plan — only present when the GET carried `fields=plan`. */
  plan?: { billing_cycles?: PayPalBillingCycleLike[] };
  plan_overridden?: boolean;
  links?: Array<{ href?: string; rel?: string; method?: string }>;
}

/** GET /v1/billing/subscriptions envelope (totals appear with total_required=true). */
export interface PayPalSubscriptionsPageLike {
  subscriptions?: PayPalSubscriptionLike[];
  total_items?: number;
  total_pages?: number;
  links?: Array<{ href?: string; rel?: string; method?: string }>;
}

/**
 * Subscriptions v1 status enum -> unified NativeSubscriptionStatus.
 * APPROVAL_PENDING and APPROVED both precede billing (the buyer approves,
 * activation follows) -> "pending". SUSPENDED is resumable -> "paused".
 * EXPIRED is the terminal state of a finite schedule (regular cycles carry
 * total_cycles and billing_info a final_payment_time) -> "completed".
 * PayPal reports no distinct trial or past-due status (consecutive failures
 * suspend at the plan's payment_failure_threshold instead).
 */
const SUBSCRIPTION_STATUS_MAP: Record<string, NativeSubscriptionStatus> = {
  APPROVAL_PENDING: "pending",
  APPROVED: "pending",
  ACTIVE: "active",
  SUSPENDED: "paused",
  CANCELLED: "canceled",
  EXPIRED: "completed",
};

/** Maps a PayPal subscription status onto the unified vocabulary; unrecognized values become "unknown", never a guess. */
export function mapPayPalSubscriptionStatus(status: string | undefined): NativeSubscriptionStatus {
  return SUBSCRIPTION_STATUS_MAP[(status ?? "").toUpperCase()] ?? "unknown";
}

const INTERVAL_MAP: Record<string, NativeSubscriptionInterval> = {
  DAY: "day",
  WEEK: "week",
  MONTH: "month",
  YEAR: "year",
};

/**
 * Normalizes a Subscriptions v1 subscription object into the unified record.
 * The recurring amount comes from the first REGULAR billing cycle's
 * pricing_scheme.fixed_price (requires the GET to have carried `fields=plan`);
 * tier-priced plans have no fixed_price, so the last collected payment amount
 * is the fallback. A subscription reporting neither is rejected rather than
 * given an invented amount.
 */
export function paypalSubscriptionToRecord(subscription: PayPalSubscriptionLike): NativeSubscriptionRecord {
  const id = subscription.id;
  if (!id) {
    throw PayFanoutError.invalidRequest("PayPal returned a subscription without an id", subscription);
  }
  const regular = regularBillingCycle(subscription);
  const money = regular?.pricing_scheme?.fixed_price?.value !== undefined
    ? regular.pricing_scheme.fixed_price
    : subscription.billing_info?.last_payment?.amount;
  if (money?.value === undefined || !money.currency_code) {
    throw new PayFanoutError({
      code: "invalid_request",
      message:
        `PayPal subscription "${id}" reports no recurring amount — the plan's regular billing cycle has no ` +
        "fixed_price and no payment has been collected yet",
      retryable: false,
      raw: subscription,
      pspName: PAYPAL_PSP_NAME,
    });
  }
  const currency = normalizeCurrency(money.currency_code);
  const interval = INTERVAL_MAP[(regular?.frequency?.interval_unit ?? "").toUpperCase()];
  const intervalCount = regular?.frequency?.interval_count;
  const customer = subscriptionCustomer(subscription);
  const vaultToken = subscription.subscriber?.payment_source?.card?.attributes?.vault?.id;
  return {
    id,
    pspName: PAYPAL_PSP_NAME,
    status: mapPayPalSubscriptionStatus(subscription.status),
    amount: fromPayPalValue(money.value, currency),
    currency,
    ...(interval ? { interval } : {}),
    ...(interval
      ? { intervalCount: Number.isInteger(intervalCount) && intervalCount! >= 1 ? intervalCount! : 1 }
      : {}),
    ...(subscription.billing_info?.next_billing_time
      ? { currentPeriodEnd: subscription.billing_info.next_billing_time }
      : {}),
    ...(vaultToken ? { savedPaymentMethodToken: vaultToken } : {}),
    ...(subscription.subscriber?.payer_id ? { pspCustomerId: subscription.subscriber.payer_id } : {}),
    ...(customer ? { customer } : {}),
    ...(subscription.custom_id ? { merchantRefNum: subscription.custom_id } : {}),
    ...(subscription.plan_id ? { planId: subscription.plan_id } : {}),
    raw: subscription,
  };
}

/** The first REGULAR cycle by sequence — trial cycles run first and are temporary, never the recurring price. */
function regularBillingCycle(subscription: PayPalSubscriptionLike): PayPalBillingCycleLike | undefined {
  const cycles = (subscription.plan?.billing_cycles ?? []).filter(
    (cycle) => (cycle.tenure_type ?? "").toUpperCase() === "REGULAR",
  );
  cycles.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  return cycles[0];
}

function subscriptionCustomer(
  subscription: PayPalSubscriptionLike,
): NativeSubscriptionRecord["customer"] | undefined {
  const subscriber = subscription.subscriber;
  const phone = subscriber?.phone?.phone_number?.national_number;
  const customer = {
    ...(subscriber?.email_address ? { email: subscriber.email_address } : {}),
    ...(subscriber?.name?.given_name ? { firstName: subscriber.name.given_name } : {}),
    ...(subscriber?.name?.surname ? { lastName: subscriber.name.surname } : {}),
    ...(phone ? { phone } : {}),
  };
  return Object.keys(customer).length > 0 ? customer : undefined;
}
