// @vitest-environment jsdom
import { Activity, StrictMode, useEffect, type JSX, type ReactNode } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PayFanoutError, type UnifiedError } from "@payfanout/core";
import {
  PayFanoutProvider,
  PaymentFields,
  usePayFanout,
  useRedirectReturn,
  type PayResult,
} from "../src/index.js";
import { deferred, FakeClientAdapter } from "./fake-client-adapter.js";

afterEach(cleanup);

function StatusProbe(): JSX.Element {
  const { status } = usePayFanout();
  return <span data-testid="status">{status}</span>;
}

function LastErrorProbe({ onLastError }: { onLastError: (err: UnifiedError | undefined) => void }): null {
  const { lastError } = usePayFanout();
  useEffect(() => {
    onLastError(lastError);
  }, [lastError, onLastError]);
  return null;
}

// Lets every pending effect, microtask and state update land before counting.
const settle = (): Promise<void> => act(async () => {});

const noAdapterMessage = (psp: string): string => `No client adapter registered for psp "${psp}"`;

describe("StrictMode (dev double-invoked effects)", () => {
  it("PaymentFields mounts the hosted fields exactly once and reaches ready", async () => {
    const adapter = new FakeClientAdapter();
    const onReady = vi.fn();
    render(
      <StrictMode>
        <PayFanoutProvider adapters={[adapter]}>
          <PaymentFields clientSecret="cs_1" onReady={onReady} />
          <StatusProbe />
        </PayFanoutProvider>
      </StrictMode>,
    );
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("ready"));
    // The cancelled first invocation must bail after loadSdk, never mounting
    // into a container the second invocation owns.
    expect(adapter.mountCalls).toHaveLength(1);
    expect(adapter.unmountCalls).toBe(0);
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it("useRedirectReturn resolves a matching return with onResult exactly once", async () => {
    const redirecting = new FakeClientAdapter("redirecting");
    let probes = 0;
    redirecting.handleRedirectReturn = async () => {
      probes++;
      return { status: "succeeded" };
    };
    const results: PayResult[] = [];
    function Probe(): JSX.Element {
      const state = useRedirectReturn({
        location: { search: "?r=1" },
        onResult: (result) => void results.push(result),
      });
      return <span data-testid="phase">{state.phase}</span>;
    }
    render(
      <StrictMode>
        <PayFanoutProvider adapters={[redirecting]}>
          <Probe />
        </PayFanoutProvider>
      </StrictMode>,
    );
    await waitFor(() => expect(screen.getByTestId("phase").textContent).toBe("complete"));
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ status: "succeeded" });
    // Both invocations probe (read-only, safe); only the survivor resolves.
    expect(probes).toBe(2);
  });

  it("useRedirectReturn reaches 'none' when the async probe matches nothing", async () => {
    const probing = new FakeClientAdapter("probing");
    probing.handleRedirectReturn = async () => null;
    const onResult = vi.fn();
    function Probe(): JSX.Element {
      const state = useRedirectReturn({ location: { search: "?x=1" }, onResult });
      return <span data-testid="phase">{state.phase}</span>;
    }
    render(
      <StrictMode>
        <PayFanoutProvider adapters={[probing]}>
          <Probe />
        </PayFanoutProvider>
      </StrictMode>,
    );
    await waitFor(() => expect(screen.getByTestId("phase").textContent).toBe("none"));
    expect(onResult).not.toHaveBeenCalled();
  });
});

describe.each([
  { label: "under StrictMode", strict: true },
  { label: "without StrictMode", strict: false },
])("PaymentFields mount failures $label", ({ strict }) => {
  const inMode = (node: ReactNode): JSX.Element => (strict ? <StrictMode>{node}</StrictMode> : <>{node}</>);

  it("reports a missing PSP once", async () => {
    const onError = vi.fn();
    const onLastError = vi.fn();
    render(
      inMode(
        <PayFanoutProvider adapters={[]}>
          <PaymentFields clientSecret="cs_1" onError={onError} />
          <StatusProbe />
          <LastErrorProbe onLastError={onLastError} />
        </PayFanoutProvider>,
      ),
    );
    await settle();
    expect(onError).toHaveBeenCalledTimes(1);
    const err = onError.mock.calls[0]![0] as UnifiedError;
    expect(err.code).toBe("invalid_request");
    expect(err.message).toMatch(/^No PSP to mount/);
    expect(screen.getByTestId("status").textContent).toBe("error");
    expect(onLastError.mock.lastCall![0]).toBe(err);
  });

  it("reports an unregistered PSP once", async () => {
    const adapter = new FakeClientAdapter();
    const onError = vi.fn();
    const onLastError = vi.fn();
    render(
      inMode(
        <PayFanoutProvider adapters={[adapter]}>
          <PaymentFields psp="ghost" clientSecret="cs_1" onError={onError} />
          <StatusProbe />
          <LastErrorProbe onLastError={onLastError} />
        </PayFanoutProvider>,
      ),
    );
    await settle();
    expect(onError).toHaveBeenCalledTimes(1);
    const err = onError.mock.calls[0]![0] as UnifiedError;
    expect(err.code).toBe("invalid_request");
    expect(err.message).toBe(noAdapterMessage("ghost"));
    expect(screen.getByTestId("status").textContent).toBe("error");
    expect(onLastError.mock.lastCall![0]).toBe(err);
    expect(adapter.loadSdkCalls).toBe(0);
  });

  it("keeps status on the rejection while the first instance is still loading", async () => {
    const adapter = new FakeClientAdapter();
    adapter.mountGate = deferred<void>();
    const onError = vi.fn();
    render(
      inMode(
        <PayFanoutProvider adapters={[adapter]}>
          <PaymentFields clientSecret="cs_1" />
          <PaymentFields clientSecret="cs_2" onError={onError} />
          <StatusProbe />
        </PayFanoutProvider>,
      ),
    );
    await settle();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("status").textContent).toBe("error");
  });

  it("reports a second instance mounted alongside the first once", async () => {
    const adapter = new FakeClientAdapter();
    const onError = vi.fn();
    const onLastError = vi.fn();
    render(
      inMode(
        <PayFanoutProvider adapters={[adapter]}>
          <PaymentFields clientSecret="cs_1" />
          <PaymentFields clientSecret="cs_2" onError={onError} />
          <StatusProbe />
          <LastErrorProbe onLastError={onLastError} />
        </PayFanoutProvider>,
      ),
    );
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("ready"));
    await settle();
    expect(onError).toHaveBeenCalledTimes(1);
    const err = onError.mock.calls[0]![0] as UnifiedError;
    expect(err.message).toMatch(/one <PaymentFields>/);
    // The first instance's remount clears lastError before the rejected one
    // fails again; the provider must still end on the reported error.
    expect(onLastError.mock.lastCall![0]).toBe(err);
    expect(adapter.mountCalls).toHaveLength(1);
  });

  it("reports a second instance added while the first is live once", async () => {
    const adapter = new FakeClientAdapter();
    const onError = vi.fn();
    const checkout = (second: boolean): JSX.Element =>
      inMode(
        <PayFanoutProvider adapters={[adapter]}>
          <PaymentFields clientSecret="cs_1" />
          {second ? <PaymentFields clientSecret="cs_2" onError={onError} /> : null}
          <StatusProbe />
        </PayFanoutProvider>,
      );
    const view = render(checkout(false));
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("ready"));
    view.rerender(checkout(true));
    await settle();
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]![0] as UnifiedError).message).toMatch(/one <PaymentFields>/);
    expect(adapter.mountCalls).toHaveLength(1);
  });

  it("reports again when the psp or clientSecret changes", async () => {
    const adapter = new FakeClientAdapter();
    const onError = vi.fn();
    const checkout = (psp: string, clientSecret: string): JSX.Element =>
      inMode(
        <PayFanoutProvider adapters={[adapter]}>
          <PaymentFields psp={psp} clientSecret={clientSecret} onError={onError} />
        </PayFanoutProvider>,
      );
    const view = render(checkout("ghost", "cs_1"));
    // Same failure, new session: still a new mount the host must hear about.
    view.rerender(checkout("ghost", "cs_2"));
    view.rerender(checkout("phantom", "cs_2"));
    await settle();
    expect(onError.mock.calls.map(([err]) => (err as UnifiedError).message)).toEqual([
      noAdapterMessage("ghost"),
      noAdapterMessage("ghost"),
      noAdapterMessage("phantom"),
    ]);
  });

  it("reports a rejected second instance again when its adapter or clientSecret changes", async () => {
    const onError = vi.fn();
    const checkout = (adapter: FakeClientAdapter, clientSecret: string): JSX.Element =>
      inMode(
        <PayFanoutProvider adapters={[adapter]}>
          <PaymentFields clientSecret="cs_1" />
          <PaymentFields clientSecret={clientSecret} onError={onError} />
        </PayFanoutProvider>,
      );
    const replacement = new FakeClientAdapter();
    const view = render(checkout(new FakeClientAdapter(), "cs_2"));
    view.rerender(checkout(replacement, "cs_2"));
    view.rerender(checkout(replacement, "cs_3"));
    await settle();
    expect(onError).toHaveBeenCalledTimes(3);
    for (const [err] of onError.mock.calls) expect((err as UnifiedError).message).toMatch(/one <PaymentFields>/);
  });

  it("reports the same failure again after the inputs recovered in between", async () => {
    const adapter = new FakeClientAdapter();
    const onError = vi.fn();
    const checkout = (psp: string): JSX.Element =>
      inMode(
        <PayFanoutProvider adapters={[adapter]}>
          <PaymentFields psp={psp} clientSecret="cs_1" onError={onError} />
        </PayFanoutProvider>,
      );
    const view = render(checkout("ghost"));
    view.rerender(checkout("fakepsp"));
    view.rerender(checkout("ghost"));
    await settle();
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it("reports again for a new instance that replaces an unmounted one", async () => {
    const onError = vi.fn();
    const checkout = (shown: boolean): JSX.Element =>
      inMode(
        <PayFanoutProvider adapters={[]}>
          {shown ? <PaymentFields clientSecret="cs_1" onError={onError} /> : null}
        </PayFanoutProvider>,
      );
    const view = render(checkout(true));
    view.rerender(checkout(false));
    view.rerender(checkout(true));
    await settle();
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it("reports again each time an <Activity> reveals the fields", async () => {
    const onError = vi.fn();
    const checkout = (mode: "visible" | "hidden"): JSX.Element =>
      inMode(
        <PayFanoutProvider adapters={[]}>
          <Activity mode={mode}>
            <PaymentFields clientSecret="cs_1" onError={onError} />
          </Activity>
        </PayFanoutProvider>,
      );
    const view = render(checkout("visible"));
    await settle();
    expect(onError).toHaveBeenCalledTimes(1);
    // A reveal re-creates the effects: a new mount, which fails again.
    view.rerender(checkout("hidden"));
    await settle();
    view.rerender(checkout("visible"));
    await settle();
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it("keeps the report when the fields unmount straight after failing, and adds none", async () => {
    const onError = vi.fn();
    const view = render(
      inMode(
        <PayFanoutProvider adapters={[]}>
          <PaymentFields clientSecret="cs_1" onError={onError} />
        </PayFanoutProvider>,
      ),
    );
    view.unmount();
    await settle();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("still reports an asynchronous mount failure once", async () => {
    const adapter = new FakeClientAdapter();
    const failure = new PayFanoutError({ code: "psp_unavailable", message: "SDK failed.", retryable: true, pspName: "fakepsp" });
    adapter.mountError = failure;
    adapter.reportMountErrorToo = true;
    const onError = vi.fn();
    render(
      inMode(
        <PayFanoutProvider adapters={[adapter]}>
          <PaymentFields clientSecret="cs_1" onError={onError} />
          <StatusProbe />
        </PayFanoutProvider>,
      ),
    );
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("error"));
    await settle();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toBe(failure);
    expect(adapter.mountCalls).toHaveLength(1);
  });
});
