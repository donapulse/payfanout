// @vitest-environment jsdom
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { isPayFanoutError } from "@payfanout/core";
import { PayButton, PayFanoutProvider, PaymentFields, usePayFanout, type PayResult } from "../src/index.js";
import { FakeClientAdapter } from "./fake-client-adapter.js";

afterEach(cleanup);

describe("react bindings edge cases", () => {
  it("setActivePsp rejects unregistered PSPs", () => {
    const adapter = new FakeClientAdapter("stripe");
    const wrapper = ({ children }: { children: ReactNode }): JSX.Element => (
      <PayFanoutProvider adapters={[adapter]}>{children}</PayFanoutProvider>
    );
    const { result } = renderHook(() => usePayFanout(), { wrapper });
    expect(() => result.current.setActivePsp("ghost")).toThrowError(/no client adapter registered/);
  });

  it("PayButton wraps a confirm() that throws (instead of resolving with an error)", async () => {
    const adapter = new FakeClientAdapter();
    const explosion = new Error("SDK crashed mid-confirm");
    adapter.confirmImpl = async () => {
      throw explosion;
    };
    const results: PayResult[] = [];
    render(
      <PayFanoutProvider adapters={[adapter]}>
        <PaymentFields clientSecret="cs_1" />
        <PayButton onResult={(r) => void results.push(r)} />
      </PayFanoutProvider>,
    );
    await waitFor(() => expect(adapter.mountCalls).toHaveLength(1));
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(results).toHaveLength(1));
    expect(results[0]!.status).toBe("failed");
    const error = results[0]!.error;
    expect(error?.raw).toBe(explosion);
    expect(isPayFanoutError(error) && error.pspName).toBe("fakepsp");
  });

  it("teardown survives an adapter whose unmount throws", async () => {
    const adapter = new FakeClientAdapter();
    adapter.unmount = () => {
      throw new Error("teardown bug in PSP SDK");
    };
    const view = render(
      <PayFanoutProvider adapters={[adapter]}>
        <PaymentFields clientSecret="cs_1" />
      </PayFanoutProvider>,
    );
    await waitFor(() => expect(adapter.mountCalls).toHaveLength(1));
    expect(() => view.unmount()).not.toThrow(); // React teardown must never break
  });
});
