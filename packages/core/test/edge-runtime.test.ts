import { describe, expect, it } from "vitest";

describe("edge-runtime compatibility", () => {
  it("core's runtime sources use no Node-only builtins (WebCrypto only)", async () => {
    // Same static guard the edge-compatible server adapters carry: they now
    // build on core's webcrypto/transport modules, so node:crypto/Buffer
    // sneaking into core would silently break Cloudflare Workers / Next.js
    // edge deployments for every adapter at once.
    const { readdir, readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const srcDir = fileURLToPath(new URL("../src", import.meta.url));
    const offenders: string[] = [];
    for (const file of await readdir(srcDir, { recursive: true })) {
      const path = join(srcDir, String(file));
      const content = await readFile(path, "utf8").catch(() => ""); // directories
      if (/from "node:|require\("node:|Buffer\./.test(content)) offenders.push(String(file));
    }
    expect(offenders).toEqual([]);
  });
});
