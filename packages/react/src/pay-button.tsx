"use client";
import { type CSSProperties, type ReactNode } from "react";
import { getUiLabel } from "@payfanout/core";
import { type PayResult, type ServerCompletionCallback } from "./pay-logic.js";
import { usePay } from "./use-pay.js";
import { usePayFanoutContext } from "./provider.js";

export interface PayButtonProps {
  /** Receives one uniform result for BOTH completion shapes (§4a). */
  onResult: (result: PayResult) => void;
  /**
   * Required when the active PSP is tokenize-first (Paysafe): called with the
   * clientToken from confirm(); should POST to the host's own API route, which
   * calls PaymentService.completePayment and returns the PaymentInfo.
   */
  onServerCompletion?: ServerCompletionCallback;
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
  disabled,
  className,
  style,
  children,
}: PayButtonProps): ReactNode {
  const { pay, paying } = usePay({ onServerCompletion });
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
