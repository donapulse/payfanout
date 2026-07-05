// @vitest-environment jsdom
import { useState, type JSX } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { FieldsChangeState } from "@payfanout/core";
import { PayFanoutProvider, PaymentFields } from "../src/index.js";
import { FakeClientAdapter } from "./fake-client-adapter.js";

afterEach(cleanup);

describe("PaymentFields onChange passthrough", () => {
  it("forwards adapter field-state events to the host, dropping them after unmount", async () => {
    const adapter = new FakeClientAdapter("fakepsp");
    const changes: FieldsChangeState[] = [];
    const { unmount } = render(
      <PayFanoutProvider adapters={[adapter]}>
        <PaymentFields clientSecret="secret_1" onChange={(state) => changes.push(state)} />
      </PayFanoutProvider>,
    );
    await waitFor(() => expect(adapter.mountCalls).toHaveLength(1));

    // The adapter's mount received a live onChange bridge.
    act(() => adapter.mountCalls[0]!.onChange?.({ complete: false, empty: true }));
    act(() => adapter.mountCalls[0]!.onChange?.({ complete: true }));
    expect(changes).toEqual([{ complete: false, empty: true }, { complete: true }]);

    unmount();
    adapter.mountCalls[0]!.onChange?.({ complete: false }); // late SDK event after teardown
    expect(changes).toHaveLength(2); // swallowed — no post-unmount state updates
  });

  it("the canonical use: disabling Pay until fields are complete", async () => {
    const adapter = new FakeClientAdapter("fakepsp");
    function Checkout(): JSX.Element {
      const [complete, setComplete] = useState(false);
      return (
        <>
          <PaymentFields clientSecret="secret_1" onChange={(state) => setComplete(state.complete)} />
          <button disabled={!complete}>Pay</button>
        </>
      );
    }
    const { getByRole } = render(
      <PayFanoutProvider adapters={[adapter]}>
        <Checkout />
      </PayFanoutProvider>,
    );
    await waitFor(() => expect(adapter.mountCalls).toHaveLength(1));
    expect((getByRole("button") as HTMLButtonElement).disabled).toBe(true);
    act(() => adapter.mountCalls[0]!.onChange?.({ complete: true }));
    expect((getByRole("button") as HTMLButtonElement).disabled).toBe(false);
  });
});
