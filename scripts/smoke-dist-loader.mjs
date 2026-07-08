// Module hook for smoke-dist.mjs: in-repo, workspace exports point at TS
// source (dist only replaces it at publish time via publishConfig), so
// cross-package imports of a dist entry must be redirected to the dependency's
// dist — the resolution a published consumer actually gets.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PKG_DIR = join(ROOT, "packages");

const distByName = new Map();
for (const dir of readdirSync(PKG_DIR)) {
  const pkgPath = join(PKG_DIR, dir, "package.json");
  if (!existsSync(pkgPath)) continue;
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  if (pkg.private || !pkg.publishConfig) continue;
  const entryRel = pkg.publishConfig.exports?.["."]?.default ?? pkg.publishConfig.main ?? "dist/index.js";
  distByName.set(pkg.name, pathToFileURL(join(PKG_DIR, dir, entryRel)).href);
}

export async function resolve(specifier, context, nextResolve) {
  const dist = distByName.get(specifier);
  if (dist) return { url: dist, shortCircuit: true };
  return nextResolve(specifier, context);
}
