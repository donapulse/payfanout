"use client";
import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { PayFanoutError, type FieldsChangeState, type UnifiedError } from "@payfanout/core";
import { usePayFanoutContext } from "./provider.js";
import { useLatestRef } from "./use-latest-ref.js";

export interface SaveConsentOptions {
  /** Rendered inside the label; defaults to "Save my card for future payments". */
  label?: ReactNode;
  /** Initial state — unchecked unless explicitly set. */
  defaultChecked?: boolean;
  /** Fires with the new checked state on every toggle. */
  onChange?: (checked: boolean) => void;
}

export interface PaymentFieldsProps {
  /** Defaults to the provider's active PSP. */
  psp?: string;
  /** PaymentSession.clientSecret from the server's createPaymentSession. */
  clientSecret: string;
  /**
   * Visual theme for the hosted fields. Pass the small cross-PSP **common token
   * set** — `colorPrimary`, `colorText`, `colorDanger`, `colorBackground`,
   * `fontFamily`, `fontSize` — and each adapter translates it to its PSP's native
   * format, so one `appearance` styles whichever PSP is active. PSP-native shapes
   * still pass through for power users (Stripe's Appearance API `{ variables, theme,
   * rules }`; Paysafe's `style` selector map like `{ input: { … } }`). Paysafe warns
   * (console) about entries it cannot apply — e.g. a Stripe `variables` object.
   */
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
  /**
   * Renders an accessible "save my card" consent checkbox after the hosted
   * fields — unchecked by default, never auto-saved. The checkbox only
   * REPORTS consent via onChange: the host forwards it to its own server,
   * which sets `savePaymentMethod: true` on createPaymentSession when (and
   * only when) the customer checked it. Style it via
   * [data-payfanout-save-consent].
   */
  saveConsent?: SaveConsentOptions;
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
  saveConsent,
}: PaymentFieldsProps): ReactNode {
  const { adapters, activePsp, setStatus, setLastError, mountedRef, fieldsOwnerRef } = usePayFanoutContext();
  const containerRef = useRef<HTMLDivElement | null>(null);
  // This instance's identity — the token it claims the provider's single
  // mount slot with.
  const instanceRef = useRef<object>({});
  // Latest mount inputs and callbacks: SDK events fire long after the mount
  // effect ran, and appearance/fieldOptions/locale must not be effect
  // dependencies (PSP SDKs handle live option updates poorly; remount by
  // changing clientSecret/psp instead).
  const latestRef = useLatestRef({ appearance, fieldOptions, locale, onReady, onError, onChange });

  const targetPsp = psp ?? activePsp;
  // Resolved during render so the mount effect keys on the adapter INSTANCE:
  // a host re-rendering with an inline adapters array rebuilds the registry
  // Map, and remounting on Map identity would wipe typed card data.
  const adapter = targetPsp === undefined ? undefined : adapters.get(targetPsp);

  useEffect(() => {
    const container = containerRef.current;
    const instance = instanceRef.current;
    if (!container) return;

    const fail = (err: PayFanoutError): void => {
      setLastError(err);
      setStatus("error");
      latestRef.current.onError?.(err);
    };
    if (targetPsp === undefined) {
      fail(
        PayFanoutError.invalidRequest(
          "No PSP to mount — pass <PaymentFields psp> or register at least one adapter with <PayFanoutProvider>",
        ),
      );
      return;
    }
    if (!adapter) {
      fail(PayFanoutError.invalidRequest(`No client adapter registered for psp "${targetPsp}"`));
      return;
    }
    if (fieldsOwnerRef.current !== null && fieldsOwnerRef.current !== instance) {
      fail(
        PayFanoutError.invalidRequest(
          "Only one <PaymentFields> may be mounted at a time — unmount the other instance first",
        ),
      );
      return;
    }
    fieldsOwnerRef.current = instance;

    let cancelled = false;
    let cleanupHandle: (() => void) | undefined;
    // Snapshot now: the mount must use this render's inputs even if the host
    // re-renders while the SDK is still loading.
    const { appearance, fieldOptions, locale } = latestRef.current;
    setStatus("loading-sdk");
    setLastError(undefined);

    void (async () => {
      try {
        await adapter.loadSdk();
        // A StrictMode/remount cleanup may have run while the SDK loaded —
        // the container now belongs to a newer invocation; never mount into it.
        if (cancelled) return;
        const handle = await adapter.mount(container, {
          clientSecret,
          appearance,
          fieldOptions,
          locale,
          onReady: () => {
            if (!cancelled) latestRef.current.onReady?.();
          },
          onError: (err) => {
            if (cancelled) return;
            setLastError(err);
            setStatus("error");
            latestRef.current.onError?.(err);
          },
          onChange: (state) => {
            if (!cancelled) latestRef.current.onChange?.(state);
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
        latestRef.current.onError?.(wrapped);
      }
    })();

    return () => {
      cancelled = true;
      try {
        cleanupHandle?.();
      } catch {
        // Unmount failures must never break React teardown.
      }
      // Only the slot owner releases it — a rejected second instance
      // unmounting must not reset the live instance's status or slot.
      if (fieldsOwnerRef.current === instance) {
        fieldsOwnerRef.current = null;
        setStatus("idle");
      }
    };
  }, [adapter, targetPsp, clientSecret, setStatus, setLastError, mountedRef, fieldsOwnerRef, latestRef]);

  return (
    <div ref={containerRef} className={className} style={style} data-payfanout-fields={targetPsp ?? ""}>
      {children}
      {saveConsent ? (
        // A wrapping <label> gives the native checkbox its accessible name —
        // no ids needed, so multiple checkouts never collide.
        <label data-payfanout-save-consent="">
          <input
            type="checkbox"
            data-payfanout-save-consent-input=""
            defaultChecked={saveConsent.defaultChecked ?? false}
            onChange={(event) => saveConsent.onChange?.(event.currentTarget.checked)}
          />
          {saveConsent.label ?? "Save my card for future payments"}
        </label>
      ) : null}
    </div>
  );
}
