// Imports every published package's built entry point so a broken dist/
// (bad publishConfig path, missing emit, unresolvable import) fails the build
// job instead of the npm publish. A module hook redirects @payfanout/*
// imports to each dependency's dist, mirroring published resolution.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

register(new URL("./smoke-dist-loader.mjs", import.meta.url));

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PKG_DIR = join(ROOT, "packages");

const failures = [];
let checked = 0;

for (const dir of readdirSync(PKG_DIR)) {
  const pkgPath = join(PKG_DIR, dir, "package.json");
  if (!existsSync(pkgPath)) continue;
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  if (pkg.private || !pkg.publishConfig) continue;

  const entryRel = pkg.publishConfig.exports?.["."]?.default ?? pkg.publishConfig.main ?? "dist/index.js";
  const entry = join(PKG_DIR, dir, entryRel);
  if (!existsSync(entry)) {
    failures.push(`${pkg.name}: published entry ${entryRel} does not exist — run the build first`);
    continue;
  }
  try {
    const mod = await import(pathToFileURL(entry).href);
    if (!mod || Object.keys(mod).length === 0) {
      failures.push(`${pkg.name}: ${entryRel} loaded but exports nothing`);
      continue;
    }
    checked += 1;
  } catch (err) {
    failures.push(`${pkg.name}: importing ${entryRel} threw — ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Behavioral canary on top of loadability: minor-unit math through the dist build.
const core = await import(pathToFileURL(join(PKG_DIR, "core", "dist", "index.js")).href);
if (core.toMinorUnits(10.99, "USD") !== 1099) {
  failures.push("@payfanout/core: toMinorUnits(10.99, 'USD') !== 1099 through dist");
}

if (failures.length > 0) {
  console.error("dist smoke failures:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
console.log(`dist OK: ${checked} published packages import cleanly`);
