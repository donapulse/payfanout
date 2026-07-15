import { describe, expect, it } from "vitest";
import {
  PAYMENT_METHOD_FLOWS,
  PAYMENT_METHOD_TYPES,
  type ClientPaymentAdapter,
} from "@payfanout/core";

/**
 * Client adapters wrap PSP browser SDKs, so full mount/confirm behavior can
 * only be exercised against the real SDK in a browser. This suite pins down
 * everything verifiable without one: the static contract surface and honest
 * capability reporting (embedded vs redirect vs voucher — never forced into an
 * "embedded" illusion).
 */
export interface ClientConformanceFixtures {
  /** Method types the integration is expected to expose (subset check). */
  expectedMethodTypes?: string[];
}

export function runClientAdapterConformanceTests(
  name: string,
  makeAdapter: () => ClientPaymentAdapter,
  fixtures: ClientConformanceFixtures = {},
): void {
  describe(`client adapter conformance: ${name}`, () => {
    it("exposes the full ClientPaymentAdapter surface", () => {
      const adapter = makeAdapter();
      expect(adapter.pspName.length).toBeGreaterThan(0);
      expect(typeof adapter.loadSdk).toBe("function");
      expect(typeof adapter.mount).toBe("function");
      expect(typeof adapter.confirm).toBe("function");
      expect(typeof adapter.unmount).toBe("function");
      expect(typeof adapter.listPaymentMethodCapabilities).toBe("function");
    });

    it("lists honest, well-formed payment method capabilities", () => {
      const adapter = makeAdapter();
      const methods = adapter.listPaymentMethodCapabilities();
      expect(methods.length).toBeGreaterThan(0);
      for (const method of methods) {
        expect(PAYMENT_METHOD_TYPES).toContain(method.type);
        expect(PAYMENT_METHOD_FLOWS).toContain(method.flow);
        expect(typeof method.supported).toBe("boolean");
        // The client half declares the same rail constraints as its server
        // half — hosts render from this list, so a malformed code here offers
        // a rail the server will refuse.
        for (const currency of method.currencies ?? []) {
          expect(currency).toMatch(/^[A-Z]{3}$/);
        }
        for (const country of method.countries ?? []) {
          expect(country).toMatch(/^[A-Z]{2}$/);
        }
      }
      for (const expected of fixtures.expectedMethodTypes ?? []) {
        expect(methods.map((m) => m.type)).toContain(expected);
      }
    });

    it("implements handleRedirectReturn when it reports redirect-flow methods", () => {
      const adapter = makeAdapter();
      const hasRedirect = adapter
        .listPaymentMethodCapabilities()
        .some((m) => m.flow === "redirect" && m.supported);
      if (hasRedirect) {
        // A redirect flow without a return-trip handler strands the customer.
        expect(typeof adapter.handleRedirectReturn).toBe("function");
      }
    });

    it("never resolves mount without a DOM (SSR guard)", async () => {
      const adapter = makeAdapter();
      if (typeof document !== "undefined") return; // suite runs in node by default
      await expect(
        adapter.mount(undefined as unknown as HTMLElement, { clientSecret: "x" }),
      ).rejects.toThrowError();
    });
  });
}
