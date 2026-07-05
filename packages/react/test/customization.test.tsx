// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PayFanoutProvider, PaymentFields, usePay, type PayResult } from "../src/index.js";
import { FakeClientAdapter } from "./fake-client-adapter.js";

afterEach(cleanup);

describe("PaymentFields customization surface", () => {
  it("forwards fieldOptions and locale into the adapter's mount options", async () => {
    const adapter = new FakeClientAdapter("fakepsp");
    const fieldOptions = { layout: { type: "accordion" }, paymentMethodOrder: ["card"] };
    render(
      <PayFanoutProvider adapters={[adapter]}>
        <PaymentFields clientSecret="secret_1" fieldOptions={fieldOptions} locale="fr-CA" />
      </PayFanoutProvider>,
    );
    await waitFor(() => expect(adapter.mountCalls).toHaveLength(1));
    expect(adapter.mountCalls[0]).toMatchObject({ fieldOptions, locale: "fr-CA" });
  });

  it("renders children INSIDE the mount container — the slot layout reaches the adapter's DOM", async () => {
    const adapter = new FakeClientAdapter("fakepsp");
    const { container } = render(
      <PayFanoutProvider adapters={[adapter]}>
        <PaymentFields clientSecret="secret_1">
          <div className="my-grid">
            <div data-payfanout-field="cardNumber" data-testid="slot-number" />
            <div className="row">
              <div data-payfanout-field="expiryDate" />
              <div data-payfanout-field="cvv" />
            </div>
          </div>
        </PaymentFields>
      </PayFanoutProvider>,
    );
    await waitFor(() => expect(adapter.mountCalls).toHaveLength(1));
    const mountContainer = container.querySelector("[data-payfanout-fields]")!;
    // The host's structure lives inside the exact element handed to mount().
    expect(mountContainer.querySelector('[data-payfanout-field="cardNumber"]')).not.toBeNull();
    expect(mountContainer.querySelector('[data-payfanout-field="cvv"]')).not.toBeNull();
    expect(screen.getByTestId("slot-number")).toBeDefined();
  });
});

describe("usePay — bring-your-own-button", () => {
  function DesignSystemCheckout(props: { onResult: (r: PayResult) => void }): JSX.Element {
    const { pay, paying } = usePay();
    return (
      <>
        <PaymentFields clientSecret="secret_1" />
        <button
          data-testid="my-fancy-button"
          data-loading={paying}
          onClick={() => void pay().then(props.onResult)}
        >
          {paying ? "Un instant…" : "Payer maintenant"}
        </button>
      </>
    );
  }

  it("a fully custom button pays through the mounted fields", async () => {
    const adapter = new FakeClientAdapter("fakepsp");
    const results: PayResult[] = [];
    render(
      <PayFanoutProvider adapters={[adapter]}>
        <DesignSystemCheckout onResult={(r) => results.push(r)} />
      </PayFanoutProvider>,
    );
    await waitFor(() => expect(adapter.mountCalls).toHaveLength(1));
    await act(async () => {
      fireEvent.click(screen.getByTestId("my-fancy-button"));
    });
    await waitFor(() => expect(results).toHaveLength(1));
    expect(results[0]).toEqual({ status: "succeeded" });
    expect(adapter.confirmCalls).toBe(1);
  });

  it("exposes the in-flight state and fails safe without mounted fields", async () => {
    const adapter = new FakeClientAdapter("fakepsp");
    let resolveConfirm!: () => void;
    adapter.confirmImpl = () =>
      new Promise((resolve) => {
        resolveConfirm = () => resolve({ status: "succeeded" });
      });
    const results: PayResult[] = [];
    render(
      <PayFanoutProvider adapters={[adapter]}>
        <DesignSystemCheckout onResult={(r) => results.push(r)} />
      </PayFanoutProvider>,
    );
    await waitFor(() => expect(adapter.mountCalls).toHaveLength(1));
    const button = screen.getByTestId("my-fancy-button");
    fireEvent.click(button);
    await waitFor(() => expect(button.getAttribute("data-loading")).toBe("true"));
    expect(button.textContent).toBe("Un instant…"); // paying state drives the host's own UI
    await act(async () => resolveConfirm());
    await waitFor(() => expect(button.getAttribute("data-loading")).toBe("false"));

    // Without fields: a clean failed PayResult, never a throw.
    cleanup();
    const bare: PayResult[] = [];
    render(
      <PayFanoutProvider adapters={[new FakeClientAdapter("fakepsp")]}>
        <BareButton onResult={(r) => bare.push(r)} />
      </PayFanoutProvider>,
    );
    fireEvent.click(screen.getByTestId("bare-pay"));
    await waitFor(() => expect(bare).toHaveLength(1));
    expect(bare[0]!.status).toBe("failed");
    expect(bare[0]!.error?.message).toMatch(/No mounted <PaymentFields>/);
  });
});

function BareButton(props: { onResult: (r: PayResult) => void }): JSX.Element {
  const { pay } = usePay();
  return (
    <button data-testid="bare-pay" onClick={() => void pay().then(props.onResult)}>
      pay
    </button>
  );
}
