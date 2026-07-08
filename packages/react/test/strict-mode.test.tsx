// @vitest-environment jsdom
import { StrictMode, type JSX } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PayFanoutProvider,
  PaymentFields,
  usePayFanout,
  useRedirectReturn,
  type PayResult,
} from "../src/index.js";
import { FakeClientAdapter } from "./fake-client-adapter.js";

afterEach(cleanup);

function StatusProbe(): JSX.Element {
  const { status } = usePayFanout();
  return <span data-testid="status">{status}</span>;
}

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
