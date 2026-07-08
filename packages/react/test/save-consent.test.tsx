// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PayFanoutProvider, PaymentFields } from "../src/index.js";
import { FakeClientAdapter } from "./fake-client-adapter.js";

afterEach(cleanup);

describe("PaymentFields saveConsent slot", () => {
  it("renders an accessible, unchecked-by-default checkbox inside the fields container", async () => {
    const adapter = new FakeClientAdapter();
    const { container } = render(
      <PayFanoutProvider adapters={[adapter]}>
        <PaymentFields clientSecret="cs_1" saveConsent={{}} />
      </PayFanoutProvider>,
    );
    await waitFor(() => expect(adapter.mountCalls).toHaveLength(1));
    const checkbox = screen.getByRole("checkbox", { name: "Save my card for future payments" }) as HTMLInputElement;
    expect(checkbox.checked).toBe(false); // never pre-consented
    const mountContainer = container.querySelector("[data-payfanout-fields]")!;
    const label = mountContainer.querySelector("[data-payfanout-save-consent]")!;
    expect(label.tagName).toBe("LABEL"); // wrapping label = accessible name, no id wiring
    expect(label.contains(checkbox)).toBe(true);
    expect(checkbox.hasAttribute("data-payfanout-save-consent-input")).toBe(true);
    checkbox.focus();
    expect(document.activeElement).toBe(checkbox); // reachable by keyboard
  });

  it("reports every toggle through onChange and nothing on mount", async () => {
    const adapter = new FakeClientAdapter();
    const onChange = vi.fn();
    render(
      <PayFanoutProvider adapters={[adapter]}>
        <PaymentFields clientSecret="cs_1" saveConsent={{ onChange }} />
      </PayFanoutProvider>,
    );
    await waitFor(() => expect(adapter.mountCalls).toHaveLength(1));
    expect(onChange).not.toHaveBeenCalled(); // consent is an explicit act
    const checkbox = screen.getByRole("checkbox");
    fireEvent.click(checkbox);
    expect(onChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(checkbox);
    expect(onChange).toHaveBeenLastCalledWith(false);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("honors defaultChecked and a custom label node", async () => {
    const adapter = new FakeClientAdapter();
    render(
      <PayFanoutProvider adapters={[adapter]}>
        <PaymentFields
          clientSecret="cs_1"
          saveConsent={{ defaultChecked: true, label: <span>Garder ma carte</span> }}
        />
      </PayFanoutProvider>,
    );
    await waitFor(() => expect(adapter.mountCalls).toHaveLength(1));
    const checkbox = screen.getByRole("checkbox", { name: "Garder ma carte" }) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
  });

  it("renders no consent UI at all when the prop is omitted", async () => {
    const adapter = new FakeClientAdapter();
    const { container } = render(
      <PayFanoutProvider adapters={[adapter]}>
        <PaymentFields clientSecret="cs_1" />
      </PayFanoutProvider>,
    );
    await waitFor(() => expect(adapter.mountCalls).toHaveLength(1));
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(container.querySelector("[data-payfanout-save-consent]")).toBeNull();
  });

  it("comes after the host's slot children inside the container", async () => {
    const adapter = new FakeClientAdapter();
    const { container } = render(
      <PayFanoutProvider adapters={[adapter]}>
        <PaymentFields clientSecret="cs_1" saveConsent={{}}>
          <div data-payfanout-field="cardNumber" />
        </PaymentFields>
      </PayFanoutProvider>,
    );
    await waitFor(() => expect(adapter.mountCalls).toHaveLength(1));
    const children = [...container.querySelector("[data-payfanout-fields]")!.children];
    const slotIndex = children.findIndex((el) => el.matches("[data-payfanout-field]"));
    const consentIndex = children.findIndex((el) => el.matches("[data-payfanout-save-consent]"));
    expect(slotIndex).toBeGreaterThanOrEqual(0);
    expect(consentIndex).toBeGreaterThan(slotIndex);
  });
});
