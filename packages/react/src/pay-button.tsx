"use client";
import { type CSSProperties, type ReactNode } from "react";
import { getUiLabel, type CompletePaymentInput } from "@payfanout/core";
import { type PayResult, type ServerCompletionCallback } from "./pay-logic.js";
import { usePay } from "./use-pay.js";
import { usePayFanoutContext } from "./provider.js";

export interface PayButtonProps {
  /** Receives one uniform result for BOTH completion shapes (§4a). */
  onResult: (result: PayResult) => void;
  /**
   * Server completion for tokenize-first PSPs (Paysafe, PayPal). Optional when
   * `<PayFanoutProvider completionEndpoint>` is set — completion is then
   * derived automatically. Pass this to override with a custom transport: it
   * receives the clientToken from confirm() and resolves with the PaymentInfo.
   */
  onServerCompletion?: ServerCompletionCallback;
  /**
   * AVS billing collected on the payment step, forwarded to the provider's
   * `completionEndpoint`. Ignored when `onServerCompletion` is passed.
   */
  billingDetails?: CompletePaymentInput["billingDetails"];
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

/**
 * The zero-effort payment button — a thin skin over usePay(). Design systems
 * that bring their own button skip this component entirely:
 *
 *   const { pay, paying } = usePay({ onServerCompletion });
 *   <MyButton loading={paying} onClick={async () => onResult(await pay())} />
 */
export function PayButton({
  onResult,
  onServerCompletion,
  billingDetails,
  disabled,
  className,
  style,
  children,
}: PayButtonProps): ReactNode {
  const { pay, paying } = usePay({ onServerCompletion, billingDetails });
  const { locale } = usePayFanoutContext();

  return (
    <button
      type="button"
      className={className}
      style={style}
      disabled={disabled || paying}
      aria-busy={paying}
      onClick={() => void pay().then(onResult)}
      data-payfanout-paybutton=""
    >
      {children ?? getUiLabel("pay", locale)}
    </button>
  );
}
