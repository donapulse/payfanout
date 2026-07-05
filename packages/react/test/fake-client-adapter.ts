import {
  brandMountedFieldsHandle,
  type ClientPaymentAdapter,
  type ConfirmResult,
  type MountedFieldsHandle,
  type MountOptions,
  type PaymentMethodCapability,
  type RedirectReturnLocation,
} from "@payfanout/core";

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export class FakeClientAdapter implements ClientPaymentAdapter {
  readonly pspName: string;
  loadSdkCalls = 0;
  mountCalls: MountOptions[] = [];
  unmountCalls = 0;
  confirmCalls = 0;
  /** When set, mount() waits on it — lets tests exercise the unmount-while-loading race. */
  mountGate?: Deferred<void>;
  mountError?: unknown;
  confirmImpl: () => Promise<ConfirmResult> = async () => ({ status: "succeeded" });
  /**
   * Assign to make this adapter redirect-return-capable (the optional contract
   * method stays absent until a test opts in — probing skips absent methods).
   */
  handleRedirectReturn?: (location: RedirectReturnLocation) => Promise<ConfirmResult | null>;

  constructor(pspName = "fakepsp") {
    this.pspName = pspName;
  }

  async loadSdk(): Promise<void> {
    this.loadSdkCalls++;
  }

  async mount(_container: HTMLElement, options: MountOptions): Promise<MountedFieldsHandle> {
    this.mountCalls.push(options);
    if (this.mountGate) await this.mountGate.promise;
    if (this.mountError) throw this.mountError;
    options.onReady?.();
    return brandMountedFieldsHandle({ pspName: this.pspName, seq: this.mountCalls.length });
  }

  async confirm(): Promise<ConfirmResult> {
    this.confirmCalls++;
    return this.confirmImpl();
  }

  unmount(): void {
    this.unmountCalls++;
  }

  listPaymentMethodCapabilities(): PaymentMethodCapability[] {
    return [{ type: "card", flow: "embedded", supported: true }];
  }
}
