// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { JSX } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { PaymentInfo } from "@payfanout/core";
import {
  PayFanoutProvider,
  RedirectReturn,
  usePayFanout,
  useRedirectReturn,
  type PayResult,
  type RedirectReturnState,
} from "../src/index.js";
import { FakeClientAdapter } from "./fake-client-adapter.js";

afterEach(cleanup);

const paymentInfo: PaymentInfo = {
  id: "order-1",
  pspName: "redirecting",
  pspPaymentId: "pay_1",
  status: "succeeded",
  amount: 1000,
  amountRefunded: 0,
  currency: "USD",
  paymentMethodType: "ideal",
  createdAt: "2026-07-04T00:00:00.000Z",
  raw: {},
};

function Probe(props: {
  location?: { search: string };
  onResult?: (result: PayResult, psp: string) => void;
  onServerCompletion?: (token: string) => Promise<PaymentInfo>;
}): JSX.Element {
  const state = useRedirectReturn(props);
  const { activePsp } = usePayFanout();
  return (
    <div>
      <span data-testid="phase">{state.phase}</span>
      <span data-testid="status">{state.result?.status ?? ""}</span>
      <span data-testid="psp">{state.pspName ?? ""}</span>
      <span data-testid="active">{activePsp}</span>
    </div>
  );
}

describe("useRedirectReturn", () => {
  it("reports 'none' when no registered adapter recognizes the URL", async () => {
    const silent = new FakeClientAdapter("silent"); // no handleRedirectReturn at all
    const probing = new FakeClientAdapter("probing");
    probing.handleRedirectReturn = async () => null; // implements it, URL is not his
    render(
      <PayFanoutProvider adapters={[silent, probing]}>
        <Probe location={{ search: "?foo=1" }} />
      </PayFanoutProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("phase").textContent).toBe("none"));
  });

  it("resolves through the first matching adapter and activates it", async () => {
    const other = new FakeClientAdapter("other");
    other.handleRedirectReturn = async () => null;
    const redirecting = new FakeClientAdapter("redirecting");
    const seenLocations: string[] = [];
    redirecting.handleRedirectReturn = async (location) => {
      seenLocations.push(location.search);
      return { status: "succeeded" };
    };
    const results: Array<{ result: PayResult; psp: string }> = [];
    render(
      <PayFanoutProvider adapters={[other, redirecting]} initialPsp="other">
        <Probe
          location={{ search: "?payment_intent_client_secret=x" }}
          onResult={(result, psp) => results.push({ result, psp })}
        />
      </PayFanoutProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("phase").textContent).toBe("complete"));
    expect(screen.getByTestId("status").textContent).toBe("succeeded");
    expect(screen.getByTestId("psp").textContent).toBe("redirecting");
    expect(screen.getByTestId("active").textContent).toBe("redirecting"); // PSP activated for consistency
    expect(seenLocations).toEqual(["?payment_intent_client_secret=x"]);
    expect(results).toHaveLength(1); // StrictMode/dep churn must not double-fire
    expect(results[0]).toMatchObject({ psp: "redirecting", result: { status: "succeeded" } });
  });

  it("routes tokenize-first returns through onServerCompletion (§4a parity with PayButton)", async () => {
    const redirecting = new FakeClientAdapter("redirecting");
    redirecting.handleRedirectReturn = async () => ({
      status: "requires_confirmation",
      clientToken: "handle-token-1",
    });
    const tokens: string[] = [];
    render(
      <PayFanoutProvider adapters={[redirecting]}>
        <Probe
          location={{ search: "?paymentHandleId=x" }}
          onServerCompletion={async (token) => {
            tokens.push(token);
            return paymentInfo;
          }}
        />
      </PayFanoutProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("phase").textContent).toBe("complete"));
    expect(tokens).toEqual(["handle-token-1"]);
    expect(screen.getByTestId("status").textContent).toBe("succeeded");
  });

  it("surfaces adapter failures as a failed PayResult instead of throwing", async () => {
    const redirecting = new FakeClientAdapter("redirecting");
    redirecting.handleRedirectReturn = async () => {
      throw new Error("SDK blew up");
    };
    render(
      <PayFanoutProvider adapters={[redirecting]}>
        <Probe location={{ search: "?x=1" }} />
      </PayFanoutProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("phase").textContent).toBe("complete"));
    expect(screen.getByTestId("status").textContent).toBe("failed");
  });

  it("reports 'none' when no adapter implements redirect returns at all", async () => {
    render(
      <PayFanoutProvider adapters={[new FakeClientAdapter("a"), new FakeClientAdapter("b")]}>
        <Probe location={{ search: "?payment_intent_client_secret=x" }} />
      </PayFanoutProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("phase").textContent).toBe("none"));
  });
});

describe("<RedirectReturn>", () => {
  it("render-props the state and renders nothing without children", async () => {
    const redirecting = new FakeClientAdapter("redirecting");
    redirecting.handleRedirectReturn = async () => ({ status: "succeeded" });
    const { container } = render(
      <PayFanoutProvider adapters={[redirecting]}>
        <RedirectReturn location={{ search: "?r=1" }}>
          {(state: RedirectReturnState) => <span data-testid="rp">{state.phase}</span>}
        </RedirectReturn>
        <RedirectReturn location={{ search: "?r=1" }} />
      </PayFanoutProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("rp").textContent).toBe("complete"));
    expect(container.querySelectorAll("span")).toHaveLength(1);
  });
});
