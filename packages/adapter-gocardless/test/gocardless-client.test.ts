import { afterEach, describe, expect, it, vi } from "vitest";
import { isPayFanoutError, type FieldsChangeState } from "@payfanout/core";
import { runClientAdapterConformanceTests } from "@payfanout/conformance";
import { GoCardlessClientAdapter } from "../src/index.js";

const AUTH_URL = "https://pay.gocardless.com/billing/static/flow?id=BRF123";

afterEach(() => vi.unstubAllGlobals());

interface FakeElement {
  textContent: string;
  style: Record<string, string>;
  attributes: Record<string, string>;
  setAttribute(name: string, value: string): void;
  remove: ReturnType<typeof vi.fn>;
}

function fakeElement(): FakeElement {
  const el: FakeElement = {
    textContent: "",
    style: {},
    attributes: {},
    setAttribute(name, value) {
      el.attributes[name] = value;
    },
    remove: vi.fn(),
  };
  return el;
}

function stubBrowser(): { assigned: string[] } {
  const assigned: string[] = [];
  vi.stubGlobal("window", { location: { assign: (url: string) => assigned.push(url) } });
  vi.stubGlobal("document", { createElement: () => fakeElement() });
  return { assigned };
}

function fakeContainer(): HTMLElement & { children: FakeElement[] } {
  const container = {
    children: [] as FakeElement[],
    appendChild(el: FakeElement) {
      container.children.push(el);
    },
  };
  return container as never;
}

function makeAdapter(): GoCardlessClientAdapter {
  return new GoCardlessClientAdapter({ environment: "sandbox" });
}

runClientAdapterConformanceTests("gocardless", makeAdapter, {
  expectedMethodTypes: ["bank_redirect_generic", "sepa_debit", "bacs_debit"],
});

describe("GoCardlessClientAdapter", () => {
  it("validates its config eagerly", () => {
    expect(() => new GoCardlessClientAdapter({ environment: "prod" as never })).toThrowError(
      /sandbox.*live/,
    );
    expect(() => new GoCardlessClientAdapter({} as never)).toThrowError(/environment/);
  });

  it("loadSdk resolves in a browser (no SDK to inject) and rejects during SSR", async () => {
    const adapter = makeAdapter();
    await expect(adapter.loadSdk()).rejects.toThrowError(/browser-only/);
    stubBrowser();
    await expect(adapter.loadSdk()).resolves.toBeUndefined();
  });

  it("mounts an informational panel and reports fields complete immediately", async () => {
    stubBrowser();
    const adapter = makeAdapter();
    const container = fakeContainer();
    const changes: FieldsChangeState[] = [];
    let ready = false;
    await adapter.mount(container, {
      clientSecret: AUTH_URL,
      onChange: (state) => changes.push(state),
      onReady: () => (ready = true),
    });
    expect(container.children).toHaveLength(1);
    const panel = container.children[0]!;
    expect(panel.attributes["data-payfanout-gocardless-panel"]).toBe("");
    expect(panel.textContent).toMatch(/redirected to your bank/);
    // Initialized false, then complete — nothing to fill client-side.
    expect(changes).toEqual([{ complete: false }, { complete: true }]);
    expect(ready).toBe(true);
  });

  it("mounts without callbacks and honors panel text/style customization", async () => {
    stubBrowser();
    const adapter = makeAdapter();
    const container = fakeContainer();
    await adapter.mount(container, { clientSecret: AUTH_URL }); // no callbacks — must not throw

    const styled = fakeContainer();
    await adapter.mount(styled, {
      clientSecret: AUTH_URL,
      fieldOptions: { description: "Bank transfer via GoCardless" },
      appearance: { panel: { padding: "12px" }, ignored: "scalar-values-are-skipped" },
    });
    const panel = styled.children[0]!;
    expect(panel.textContent).toBe("Bank transfer via GoCardless");
    expect(panel.style).toEqual({ padding: "12px" });
  });

  it("rejects mount without a clientSecret and during SSR", async () => {
    stubBrowser();
    const adapter = makeAdapter();
    await expect(adapter.mount(fakeContainer(), { clientSecret: "" })).rejects.toThrowError(
      /clientSecret/,
    );
    vi.unstubAllGlobals();
    await expect(adapter.mount(fakeContainer(), { clientSecret: AUTH_URL })).rejects.toThrowError(
      /browser-only/,
    );
  });

  it("confirm redirects to the hosted authorisation URL and never settles", async () => {
    const { assigned } = stubBrowser();
    const adapter = makeAdapter();
    const handle = await adapter.mount(fakeContainer(), { clientSecret: AUTH_URL });
    const outcome = await Promise.race([
      adapter.confirm(handle).then(() => "settled"),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 25)),
    ]);
    // Full-page navigation is the flow for redirect methods — the promise
    // must stay pending, mirroring how Stripe treats redirect confirms.
    expect(outcome).toBe("pending");
    expect(assigned).toEqual([AUTH_URL]);
  });

  it("confirm resolves failed (not navigating) when the clientSecret is not an https URL", async () => {
    const { assigned } = stubBrowser();
    const adapter = makeAdapter();
    const handle = await adapter.mount(fakeContainer(), { clientSecret: "not-a-url" });
    const result = await adapter.confirm(handle);
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("invalid_request");
    expect(result.error?.raw).toBeDefined();
    expect(isPayFanoutError(result.error)).toBe(true);
    expect(assigned).toEqual([]);
  });

  it("confirm rejects during SSR and on foreign handles", async () => {
    stubBrowser();
    const adapter = makeAdapter();
    const handle = await adapter.mount(fakeContainer(), { clientSecret: AUTH_URL });
    vi.unstubAllGlobals();
    await expect(adapter.confirm(handle)).rejects.toThrowError(/browser-only/);
    await expect(adapter.confirm({} as never)).rejects.toThrowError(
      /not produced by GoCardlessClientAdapter/,
    );
  });

  it("handleRedirectReturn resolves processing on a GoCardless return, null otherwise", async () => {
    const adapter = makeAdapter();
    // GoCardless instructs outcomes be confirmed via webhooks/API — never the
    // redirect — so a return resolves "processing" for server-side follow-up.
    await expect(
      adapter.handleRedirectReturn({ search: "?billing_request_id=BRQ123&billing_request_flow_id=BRF123" }),
    ).resolves.toEqual({ status: "processing" });
    await expect(
      adapter.handleRedirectReturn({ search: "billing_request_id=BRQ123" }),
    ).resolves.toEqual({ status: "processing" });
    await expect(adapter.handleRedirectReturn({ search: "" })).resolves.toBeNull();
    await expect(
      adapter.handleRedirectReturn({ search: "?payment_intent_client_secret=pi_x" }),
    ).resolves.toBeNull();
  });

  it("unmount removes only the adapter-created panel", async () => {
    stubBrowser();
    const adapter = makeAdapter();
    const container = fakeContainer();
    const handle = await adapter.mount(container, { clientSecret: AUTH_URL });
    adapter.unmount(handle);
    expect(container.children[0]!.remove).toHaveBeenCalledTimes(1);
    expect(() => adapter.unmount({} as never)).toThrowError(/not produced by GoCardlessClientAdapter/);
  });

  it("honors a per-account capability override", () => {
    const adapter = new GoCardlessClientAdapter({
      environment: "sandbox",
      paymentMethods: [
        { type: "bank_redirect_generic", flow: "redirect", supported: true },
        { type: "ach", flow: "redirect", supported: true },
      ],
    });
    expect(adapter.listPaymentMethodCapabilities()).toHaveLength(2);
    expect(adapter.listPaymentMethodCapabilities()[1]).toMatchObject({ type: "ach", supported: true });
  });
});
