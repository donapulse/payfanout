"use client";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type {
  ClientPaymentAdapter,
  MountedFieldsHandle,
  PaymentMethodCapability,
  UnifiedError,
} from "@payfanout/core";

export type PayFanoutStatus = "idle" | "loading-sdk" | "ready" | "error";

export interface MountedEntry {
  psp: string;
  handle: MountedFieldsHandle;
}

export interface PayFanoutContextValue {
  adapters: ReadonlyMap<string, ClientPaymentAdapter>;
  activePsp: string | undefined;
  setActivePsp: (psp: string) => void;
  /** BCP-47 locale for library-rendered text; undefined means English. */
  locale: string | undefined;
  status: PayFanoutStatus;
  setStatus: (status: PayFanoutStatus) => void;
  lastError: UnifiedError | undefined;
  setLastError: (err: UnifiedError | undefined) => void;
  /** The currently mounted fields — what PayButton confirms. */
  mountedRef: RefObject<MountedEntry | null>;
  /**
   * Identity of the <PaymentFields> instance holding the single mount slot.
   * Claimed synchronously when its mount effect starts (before the async SDK
   * load), so a second concurrent instance is rejected instead of silently
   * stealing the slot.
   */
  fieldsOwnerRef: RefObject<object | null>;
}

const PayFanoutContext = createContext<PayFanoutContextValue | null>(null);

export interface PayFanoutProviderProps {
  /** Client adapters only — no secrets, no server logic. */
  adapters: ClientPaymentAdapter[];
  /** Defaults to the first adapter. */
  initialPsp?: string;
  /**
   * BCP-47 locale for the text the library renders itself — currently the
   * default `<PayButton>` label. PayFanout ships en/fr/de/es; unknown locales
   * fall back to English. Does not touch the PSP's hosted field texts (set
   * those via `<PaymentFields locale>`).
   */
  locale?: string;
  children: ReactNode;
}

/**
 * Registers client adapters and tracks the active PSP. PSP SDKs are NOT loaded
 * here — <PaymentFields> lazily loads only the adapter it actually mounts, so
 * an app with five registered PSPs still downloads one script.
 * SSR-safe: nothing here touches window/document.
 */
export function PayFanoutProvider({ adapters, initialPsp, locale, children }: PayFanoutProviderProps): ReactNode {
  const registry = useMemo(() => {
    const map = new Map<string, ClientPaymentAdapter>();
    for (const adapter of adapters) {
      if (map.has(adapter.pspName)) {
        throw new Error(`[payfanout] duplicate client adapter for psp "${adapter.pspName}"`);
      }
      map.set(adapter.pspName, adapter);
    }
    // Eager: a typo'd initialPsp must fail at the provider, not as a silent
    // no-mount later.
    if (initialPsp !== undefined && !map.has(initialPsp)) {
      throw new Error(`[payfanout] no client adapter registered for psp "${initialPsp}"`);
    }
    return map;
  }, [adapters, initialPsp]);

  const [activePsp, setActivePspState] = useState<string | undefined>(
    initialPsp ?? adapters[0]?.pspName,
  );
  const [status, setStatus] = useState<PayFanoutStatus>("idle");
  const [lastError, setLastError] = useState<UnifiedError | undefined>(undefined);
  const mountedRef = useRef<MountedEntry | null>(null);
  const fieldsOwnerRef = useRef<object | null>(null);

  const setActivePsp = useCallback(
    (psp: string) => {
      if (!registry.has(psp)) throw new Error(`[payfanout] no client adapter registered for psp "${psp}"`);
      setActivePspState(psp);
    },
    [registry],
  );

  const value = useMemo<PayFanoutContextValue>(
    () => ({
      adapters: registry,
      activePsp,
      setActivePsp,
      locale,
      status,
      setStatus,
      lastError,
      setLastError,
      mountedRef,
      fieldsOwnerRef,
    }),
    [registry, activePsp, setActivePsp, locale, status, lastError],
  );

  return <PayFanoutContext.Provider value={value}>{children}</PayFanoutContext.Provider>;
}

export function usePayFanoutContext(): PayFanoutContextValue {
  const context = useContext(PayFanoutContext);
  if (!context) throw new Error("[payfanout] usePayFanout/PaymentFields/PayButton must be inside <PayFanoutProvider>");
  return context;
}

export interface UsePayFanoutResult {
  activePsp: string | undefined;
  setActivePsp: (psp: string) => void;
  availablePsps: string[];
  /** The active adapter's honest capability list (embedded vs redirect vs voucher). */
  capabilities: PaymentMethodCapability[];
  /** The provider's locale (undefined = English), for host-side localizeError calls. */
  locale: string | undefined;
  status: PayFanoutStatus;
  lastError: UnifiedError | undefined;
}

export function usePayFanout(): UsePayFanoutResult {
  const { adapters, activePsp, setActivePsp, locale, status, lastError } = usePayFanoutContext();
  return useMemo(
    () => ({
      activePsp,
      setActivePsp,
      availablePsps: [...adapters.keys()],
      capabilities: activePsp ? (adapters.get(activePsp)?.listPaymentMethodCapabilities() ?? []) : [],
      locale,
      status,
      lastError,
    }),
    [adapters, activePsp, setActivePsp, locale, status, lastError],
  );
}
