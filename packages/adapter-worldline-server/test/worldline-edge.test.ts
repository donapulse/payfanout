import { describe, expect, it } from "vitest";
import { isPayFanoutError } from "@payfanout/core";
import { WorldlineServerAdapter, type WorldlineServerAdapterConfig } from "../src/index.js";

function makeAdapter(overrides: Partial<WorldlineServerAdapterConfig>): WorldlineServerAdapter {
  return new WorldlineServerAdapter({
    apiKeyId: "api-key-id",
    secretApiKey: "secret-api-key",
    merchantId: "mid-1",
    environment: "sandbox",
    sessionSigningKey: "sk",
    webhookKeys: [{ keyId: "wh", secretKey: "whs" }],
    ...overrides,
  });
}

describe("edge-runtime compatibility", () => {
  it("the adapter's runtime sources use no Node-only builtins (WebCrypto only)", async () => {
    // Static guard: node:crypto/Buffer sneaking back in would silently break
    // Cloudflare Workers / Next.js edge deployments.
    const { readdir, readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const srcDir = fileURLToPath(new URL("../src", import.meta.url));
    const offenders: string[] = [];
    for (const file of await readdir(srcDir)) {
      const content = await readFile(join(srcDir, file), "utf8");
      if (/from "node:|require\("node:|Buffer\./.test(content)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});

describe("transport edge cases", () => {
  it("maps a network failure (fetch rejects) to retryable psp_unavailable", async () => {
    const adapter = makeAdapter({
      fetch: async () => {
        throw new TypeError("fetch failed: ECONNREFUSED");
      },
    });
    try {
      await adapter.retrievePayment("pay_1");
      expect.unreachable();
    } catch (err) {
      expect(isPayFanoutError(err)).toBe(true);
      if (isPayFanoutError(err)) {
        expect(err.code).toBe("psp_unavailable");
        expect(err.retryable).toBe(true);
        expect(err.raw).toBeInstanceOf(TypeError);
      }
    }
  });

  it("survives non-JSON error bodies from proxies/load balancers", async () => {
    const adapter = makeAdapter({
      fetch: async () => new Response("<html>502 Bad Gateway</html>", { status: 502 }),
    });
    await expect(adapter.retrievePayment("pay_1")).rejects.toMatchObject({ code: "psp_unavailable", retryable: true });
  });

  it("requires explicit environment and complete credentials", () => {
    expect(() => makeAdapter({ environment: "prod" as never })).toThrowError(/sandbox.*live/);
    expect(() => makeAdapter({ apiKeyId: "" })).toThrowError(/apiKeyId/);
    expect(() => makeAdapter({ webhookKeys: [] })).toThrowError(/webhookKeys/);
    expect(() => makeAdapter({ merchantId: "" })).toThrowError(/merchantId/);
  });
});
