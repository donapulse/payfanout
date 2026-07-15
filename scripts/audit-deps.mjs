/**
 * Production dependency audit — fails on high/critical advisories.
 *
 * This exists because `pnpm audit` is broken, not because we wanted our own
 * auditor. npm retired the legacy audit endpoints it calls (they now answer
 * 410 "Use the bulk advisory endpoint instead"), and no released pnpm — 10.34.5
 * or 11.13.0, both verified — has migrated yet. Upgrading is not a fix, and
 * pnpm 11 additionally stops reading `pnpm.overrides` from package.json, which
 * silently drops the CVE overrides pinned there.
 *
 * So this queries the SAME source `pnpm audit` did — npm's advisory database,
 * via /-/npm/v1/security/advisories/bulk — and keeps the same severity
 * vocabulary, so the gate's meaning is unchanged. The endpoint filters
 * advisories against the exact versions posted, so no semver range matching
 * happens here (getting that subtly wrong is how an audit goes quietly green).
 *
 * Delete this and restore `pnpm audit --prod --audit-level high` once pnpm
 * ships the bulk-endpoint client: https://github.com/pnpm/pnpm/issues/11265
 */
import { execSync } from "node:child_process";

/** --all includes dev dependencies; --warn-only reports without failing the build. */
const INCLUDE_DEV = process.argv.includes("--all");
const WARN_ONLY = process.argv.includes("--warn-only");

const FAIL_ON = new Set(["high", "critical"]);
const BULK_ENDPOINT = "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk";
/** The endpoint rejects very large bodies; well under any observed limit. */
const CHUNK_SIZE = 250;

/** Workspace links and tarball/git specs have no registry advisories to look up. */
function isRegistryVersion(version) {
  return typeof version === "string" && /^\d+\.\d+\.\d+/.test(version);
}

function collect(dependencies, found) {
  for (const [name, info] of Object.entries(dependencies ?? {})) {
    if (isRegistryVersion(info?.version)) {
      (found.get(name) ?? found.set(name, new Set()).get(name)).add(info.version);
    }
    // A cycle would otherwise recurse forever; pnpm reports them as repeats.
    if (info?.dependencies) collect(info.dependencies, found);
  }
  return found;
}

function productionTree() {
  // A constant command string: nothing is interpolated, so the shell (needed to
  // resolve pnpm's .cmd shim on Windows) has nothing to inject into.
  const raw = execSync(`pnpm list --recursive ${INCLUDE_DEV ? "" : "--prod "}--depth Infinity --json`, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  const found = new Map();
  for (const entry of JSON.parse(raw)) {
    // pnpm reports each kind under its own key — reading only `dependencies`
    // would quietly audit a fraction of the tree and still report green.
    for (const kind of ["dependencies", "devDependencies", "optionalDependencies"]) {
      collect(entry[kind], found);
    }
  }
  return found;
}

async function advisoriesFor(chunk) {
  const body = Object.fromEntries(chunk.map(([name, versions]) => [name, [...versions]]));
  const response = await fetch(BULK_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    // Never pass silently on a broken audit — that is the failure mode this
    // whole script exists to avoid.
    throw new Error(`Advisory endpoint responded ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  return response.json();
}

const tree = productionTree();
if (tree.size === 0) throw new Error("Resolved no dependencies — refusing to report a green audit");

const entries = [...tree];
const findings = [];
for (let i = 0; i < entries.length; i += CHUNK_SIZE) {
  const advisories = await advisoriesFor(entries.slice(i, i + CHUNK_SIZE));
  for (const [name, list] of Object.entries(advisories)) {
    for (const advisory of list) {
      if (FAIL_ON.has(advisory.severity)) findings.push({ name, ...advisory });
    }
  }
}

const scope = INCLUDE_DEV ? "packages (including dev)" : "production packages";
console.log(`Audited ${tree.size} ${scope} against npm's advisory database.`);
if (findings.length === 0) {
  console.log("No high or critical advisories.");
  process.exit(0);
}
for (const f of findings) {
  console.error(`\n${f.severity.toUpperCase()}  ${f.name}  ${f.vulnerable_versions}\n  ${f.title}\n  ${f.url}`);
}
const summary = `${findings.length} high/critical advisory(ies) in ${scope}.`;
if (WARN_ONLY) {
  console.log(`::warning::${summary} Review the log.`);
  process.exit(0);
}
console.error(`\n${summary}`);
process.exit(1);
