"use client";
import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { PayFanoutError, type FieldsChangeState, type UnifiedError } from "@payfanout/core";
import { usePayFanoutContext } from "./provider.js";

export interface PaymentFieldsProps {
  /** Defaults to the provider's active PSP. */
  psp?: string;
  /** PaymentSession.clientSecret from the server's createPaymentSession. */
  clientSecret: string;
  /** Design tokens forwarded to the adapter so fields match the host app regardless of PSP. */
  appearance?: Record<string, unknown>;
  /**
   * PSP-vocabulary UI options passed through to the SDK (Stripe: Payment
   * Element `layout`/`paymentMethodOrder`/`fields`/`terms`/…; Paysafe:
   * per-field placeholders under `fields`, `locale`, …).
   */
  fieldOptions?: Record<string, unknown>;
  /** BCP-47 locale for the PSP's own field texts, where supported. */
  locale?: string;
  onReady?: () => void;
  onError?: (err: UnifiedError) => void;
  /**
   * Live field validity — fires { complete: false } on mount, then on every
   * change. The canonical "disable Pay until complete" hook, PSP-agnostic.
   */
  onChange?: (state: FieldsChangeState) => void;
  className?: string;
  style?: CSSProperties;
  /**
   * Layout slots for split-field PSPs (Paysafe): render your own structure
   * with elements carrying data-payfanout-field="cardNumber|expiryDate|cvv" and
   * the hosted fields mount INTO them — your grid, your spacing, your labels.
   * Single-element PSPs (Stripe) ignore slots; layout goes via fieldOptions.
   */
  children?: ReactNode;
}

/**
 * Thin wrapper around the active ClientPaymentAdapter.mount. Lazily loads the
 * PSP SDK on first mount, unmounts on cleanup. Card data lives exclusively in
 * the PSP's hosted fields/iframes — nothing sensitive enters React state.
 * SSR-safe: all adapter work happens in useEffect (client only).
 */
export function PaymentFields({
  psp,
  clientSecret,
  appearance,
  fieldOptions,
  locale,
  onReady,
  onError,
  onChange,
  className,
  style,
  children,
}: PaymentFieldsProps): ReactNode {
  const { adapters, activePsp, setStatus, setLastError, mountedRef } = usePayFanoutContext();
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Latest-callbacks ref, updated in an effect (never during render): the
  // mount effect below runs after this one, and SDK events fire later still.
  const callbacksRef = useRef({ onReady, onError, onChange });
  useEffect(() => {
    callbacksRef.current = { onReady, onError, onChange };
  });

  const targetPsp = psp ?? activePsp;

  useEffect(() => {
    const container = containerRef.current;
    if (!targetPsp || !container) return;
    const adapter = adapters.get(targetPsp);
    if (!adapter) {
      const err = PayFanoutError.invalidRequest(`No client adapter registered for psp "${targetPsp}"`);
      setLastError(err);
      setStatus("error");
      callbacksRef.current.onError?.(err);
      return;
    }

    let cancelled = false;
    let cleanupHandle: (() => void) | undefined;
    setStatus("loading-sdk");
    setLastError(undefined);

    void (async () => {
      try {
        await adapter.loadSdk();
        const handle = await adapter.mount(container, {
          clientSecret,
          appearance,
          fieldOptions,
          locale,
          onReady: () => {
            if (!cancelled) callbacksRef.current.onReady?.();
          },
          onError: (err) => {
            if (cancelled) return;
            setLastError(err);
            setStatus("error");
            callbacksRef.current.onError?.(err);
          },
          onChange: (state) => {
            if (!cancelled) callbacksRef.current.onChange?.(state);
          },
        });
        cleanupHandle = () => {
          if (mountedRef.current?.handle === handle) mountedRef.current = null;
          adapter.unmount(handle);
        };
        if (cancelled) {
          // Component unmounted while the SDK was still mounting.
          cleanupHandle();
          cleanupHandle = undefined;
          return;
        }
        mountedRef.current = { psp: targetPsp, handle };
        setStatus("ready");
      } catch (err) {
        if (cancelled) return;
        const wrapped = PayFanoutError.wrap(err, { pspName: targetPsp });
        setLastError(wrapped);
        setStatus("error");
        callbacksRef.current.onError?.(wrapped);
      }
    })();

    return () => {
      cancelled = true;
      try {
        cleanupHandle?.();
      } catch {
        // Unmount failures must never break React teardown.
      }
      setStatus("idle");
    };
    // appearance/fieldOptions/locale are not dependencies: PSP
    // SDKs handle live option updates poorly; remount by changing
    // clientSecret/psp instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetPsp, clientSecret, adapters]);

  return (
    <div ref={containerRef} className={className} style={style} data-payfanout-fields={targetPsp ?? ""}>
      {children}
    </div>
  );
}
