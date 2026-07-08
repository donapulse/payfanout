// @vitest-environment node
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PayButton, PayFanoutProvider, PaymentFields } from "../src/index.js";
import { FakeClientAdapter } from "./fake-client-adapter.js";

describe("server-side rendering", () => {
  it("renderToString renders the checkout shell without touching browser globals", () => {
    const adapter = new FakeClientAdapter();
    const html = renderToString(
      <PayFanoutProvider adapters={[adapter]} locale="fr">
        <PaymentFields clientSecret="cs_1">
          <div data-payfanout-field="cardNumber" />
        </PaymentFields>
        <PayButton onResult={() => {}} />
      </PayFanoutProvider>,
    );
    expect(html).toContain('data-payfanout-fields="fakepsp"');
    expect(html).toContain('data-payfanout-field="cardNumber"');
    expect(html).toContain("data-payfanout-paybutton");
    // All adapter work is deferred to client effects.
    expect(adapter.loadSdkCalls).toBe(0);
    expect(adapter.mountCalls).toHaveLength(0);
  });

  it("renderToString includes the saveConsent checkbox markup", () => {
    const adapter = new FakeClientAdapter();
    const html = renderToString(
      <PayFanoutProvider adapters={[adapter]}>
        <PaymentFields clientSecret="cs_1" saveConsent={{ onChange: () => {} }} />
      </PayFanoutProvider>,
    );
    expect(html).toContain("data-payfanout-save-consent");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("Save my card for future payments");
    expect(adapter.loadSdkCalls).toBe(0);
  });
});
