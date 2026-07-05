import { assertMinorUnitAmount } from "./currency.js";
import { PayFanoutError } from "./errors.js";
import type { PaymentInfo } from "./model.js";

export type RefundState = "none" | "partial" | "full";

/**
 * Derives refund state from amounts. PSPs do not report a "refunded" payment
 * status, so PayFanout never invents one — this is the supported way to answer
 * "has this payment been refunded".
 */
export function getRefundState(info: Pick<PaymentInfo, "amount" | "amountRefunded">): RefundState {
  assertMinorUnitAmount(info.amount, "amount");
  assertMinorUnitAmount(info.amountRefunded, "amountRefunded");
  if (info.amountRefunded === 0) return "none";
  if (info.amountRefunded > info.amount) {
    throw PayFanoutError.invalidRequest(
      `amountRefunded (${info.amountRefunded}) exceeds amount (${info.amount})`,
    );
  }
  return info.amountRefunded === info.amount ? "full" : "partial";
}
