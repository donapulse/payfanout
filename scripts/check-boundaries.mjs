// Enforces the client/server package boundary at the dependency level (§2 of the brief):
// packages that ship to the browser must never depend on anything that holds API secrets.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PKG_DIR = join(ROOT, "packages");

// Client-safe packages: allowed to depend only on other client-safe packages + react.
const CLIENT_SAFE = new Set([
  "@payfanout/core",
  "@payfanout/react",
  "@payfanout/adapter-stripe",
  "@payfanout/adapter-paysafe",
  "@payfanout/adapter-payzen",
]);
const CLIENT_ALLOWED_EXTERNAL = new Set(["react"]);

// Anything matching these must never appear in a client-safe package's deps.
const SERVER_ONLY_PATTERNS = [
  /^@payfanout\/server$/,
  /^@payfanout\/.*-server$/,
  /^stripe$/, // Node SDK — holds secret keys
  /^express$/,
  /^fastify$/,
];

let failures = [];

for (const dir of readdirSync(PKG_DIR)) {
  const pkgPath = join(PKG_DIR, dir, "package.json");
  if (!existsSync(pkgPath)) continue;
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const deps = {
    ...pkg.dependencies,
    ...pkg.peerDependencies,
    ...pkg.optionalDependencies,
  };

  if (pkg.name === "@payfanout/core" && Object.keys(pkg.dependencies ?? {}).length > 0) {
    failures.push(`@payfanout/core must have zero runtime dependencies, found: ${Object.keys(pkg.dependencies).join(", ")}`);
  }

  if (!CLIENT_SAFE.has(pkg.name)) continue;

  for (const dep of Object.keys(deps)) {
    if (SERVER_ONLY_PATTERNS.some((re) => re.test(dep))) {
      failures.push(`${pkg.name} depends on server-only package "${dep}"`);
    } else if (!CLIENT_SAFE.has(dep) && !CLIENT_ALLOWED_EXTERNAL.has(dep)) {
      failures.push(`${pkg.name} depends on "${dep}" which is not on the client-safe allowlist`);
    }
  }
}

if (failures.length > 0) {
  console.error("Package boundary violations:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
console.log("Package boundaries OK: no client-safe package depends on secret-holding code.");
