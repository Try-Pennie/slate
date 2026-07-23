// Security floor for Next.js (#1025). The 2026-07-23 production-readiness audit
// found `next` pinned at 16.2.7 while pnpm audit reported 4 high + 5 moderate
// advisories, all patched in 16.2.11. These include an App Router
// middleware/proxy bypass (Slate refreshes the auth session in edge middleware,
// so this is directly exploitable) and SSRF in Server Actions. This guard fails
// the build if `next` or `eslint-config-next` is specified below the patched floor,
// so a downgrade can't silently reopen those holes.
// Run: node --experimental-strip-types scripts/test-next-version-floor.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { assert, finish } from "./lib/harness.ts";

const FLOOR: [number, number, number] = [16, 2, 11];

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(
  readFileSync(resolve(repoRoot, "package.json"), "utf8"),
) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

// Parse the lowest version a spec permits: strip a leading range operator
// (^ ~ >= > = ) and read major.minor.patch. Anything we can't parse counts as
// below the floor so an unexpected spec shape fails loud rather than passing.
function minVersion(spec: string): [number, number, number] | null {
  const m = spec.trim().replace(/^[\^~>=<\s]+/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function meetsFloor(v: [number, number, number] | null): boolean {
  if (!v) return false;
  for (let i = 0; i < 3; i++) {
    if (v[i] > FLOOR[i]) return true;
    if (v[i] < FLOOR[i]) return false;
  }
  return true; // exactly the floor
}

const floorStr = FLOOR.join(".");
for (const name of ["next", "eslint-config-next"]) {
  const spec = pkg.dependencies?.[name] ?? pkg.devDependencies?.[name];
  assert(spec !== undefined, `package.json declares ${name}`);
  if (spec === undefined) continue;
  assert(
    meetsFloor(minVersion(spec)),
    `${name} is >= ${floorStr} (got "${spec}")`,
  );
}

finish();
