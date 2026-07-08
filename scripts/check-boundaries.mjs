// Enforces the client/server package boundary at the dependency level (§2 of the brief):
// packages that ship to the browser must never depend on anything that holds API secrets.
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
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
  "@payfanout/adapter-gocardless",
  "@payfanout/adapter-paypal",
  "@payfanout/adapter-payzen",
]);
// Server-side or test-only packages — may hold secret-bearing dependencies.
const SERVER_SIDE = [
  /^@payfanout\/server$/,
  /^@payfanout\/.*-server$/,
  /^@payfanout\/conformance$/,
  /^@payfanout\/integration-tests$/,
  /^@payfanout\/e2e$/,
];
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
const seen = new Set();

for (const dir of readdirSync(PKG_DIR)) {
  const pkgPath = join(PKG_DIR, dir, "package.json");
  if (!existsSync(pkgPath)) continue;
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  seen.add(pkg.name);
  const deps = {
    ...pkg.dependencies,
    ...pkg.peerDependencies,
    ...pkg.optionalDependencies,
  };

  if (pkg.name === "@payfanout/core" && Object.keys(pkg.dependencies ?? {}).length > 0) {
    failures.push(`@payfanout/core must have zero runtime dependencies, found: ${Object.keys(pkg.dependencies).join(", ")}`);
  }

  if (!CLIENT_SAFE.has(pkg.name)) {
    // Fail closed: a package this script cannot classify gets NO enforcement,
    // which is exactly how a new client adapter would ship unchecked.
    if (!SERVER_SIDE.some((re) => re.test(pkg.name))) {
      failures.push(
        `${pkg.name} is neither on the CLIENT_SAFE allowlist nor a recognized server-side/test package — classify it in scripts/check-boundaries.mjs`,
      );
    }
    continue;
  }

  for (const dep of Object.keys(deps)) {
    if (SERVER_ONLY_PATTERNS.some((re) => re.test(dep))) {
      failures.push(`${pkg.name} depends on server-only package "${dep}"`);
    } else if (!CLIENT_SAFE.has(dep) && !CLIENT_ALLOWED_EXTERNAL.has(dep)) {
      failures.push(`${pkg.name} depends on "${dep}" which is not on the client-safe allowlist`);
    }
  }

  // devDependencies are exempt from the manifest check (tests legitimately use
  // server code), so also scan the shipped sources for imports that would ride
  // a devDependency into the browser bundle.
  for (const file of sourceFiles(join(PKG_DIR, dir, "src"))) {
    const content = readFileSync(file, "utf8");
    for (const match of content.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g)) {
      const specifier = match[1];
      if (SERVER_ONLY_PATTERNS.some((re) => re.test(specifier))) {
        failures.push(`${pkg.name} imports server-only module "${specifier}" in ${file.slice(ROOT.length)}`);
      }
    }
  }
}

for (const name of CLIENT_SAFE) {
  if (!seen.has(name)) {
    failures.push(`CLIENT_SAFE lists "${name}" but no such package exists — remove or fix the entry`);
  }
}

function sourceFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx|js|jsx|mts|mjs)$/.test(entry)) out.push(full);
  }
  return out;
}

if (failures.length > 0) {
  console.error("Package boundary violations:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
console.log("Package boundaries OK: no client-safe package depends on secret-holding code.");
