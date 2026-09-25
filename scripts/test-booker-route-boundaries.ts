// Both booker routes carry the booker's own error boundary, from one shared
// component (#2732). The reasoning is in scripts/lib/scan-booker-boundaries.ts.
//
// Run: node --experimental-strip-types scripts/test-booker-route-boundaries.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { assert, finish } from "./lib/harness.ts";
import {
  bookerRoutes,
  nearestBoundary,
  scanBookerBoundaries,
  SHARED_BOUNDARY,
  type SourceTree,
} from "./lib/scan-booker-boundaries.ts";

const ROOT = process.cwd();

function readTree(dir: string, into = new Map<string, string>()): Map<string, string> {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) readTree(abs, into);
    else if (/\.tsx?$/.test(name)) {
      into.set(relative(ROOT, abs).split(sep).join("/"), readFileSync(abs, "utf8"));
    }
  }
  return into;
}

const real = readTree(join(ROOT, "src", "app"));

// --- the derivation finds the routes it exists for ---------------------------
//
// A scan that found no booker routes would report a clean tree forever (L98), so
// the two routes this issue is about must be among what it derives.
const routes = bookerRoutes(real);
assert(routes.includes("src/app/book/page.tsx"), "the standalone /book page is derived as a booker route");
assert(
  routes.includes("src/app/booking/[id]/page.tsx"),
  "the /booking/[id] entry every trypennie link uses is derived as a booker route",
);

// --- the real tree is clean --------------------------------------------------
const findings = scanBookerBoundaries(real);
for (const f of findings) console.error(`  ${f.route}: ${f.problem}`);
assert(findings.length === 0, "every booker route is caught by the shared booker boundary");

// --- positive controls: each way it can go wrong is caught (L1) --------------
const bookerPage = `import Booker from "@/components/Booker";\nexport default function P() { return <Booker />; }`;
const sharedBoundary = `"use client";\nimport BookerErrorBoundary from "${SHARED_BOUNDARY}";\nexport default function E(p) { return <BookerErrorBoundary {...p} page="/x" />; }`;

const missing: SourceTree = new Map([
  ["src/app/booking/[id]/page.tsx", bookerPage],
  ["src/app/global-error.tsx", `"use client";`],
]);
assert(nearestBoundary(missing, "src/app/booking/[id]/page.tsx") === null, "a route with no boundary resolves to none");
assert(
  scanBookerBoundaries(missing).some((f) => f.route === "src/app/booking/[id]/page.tsx" && /global-error/.test(f.problem)),
  "a booker route left on the backstop is caught",
);

const copied: SourceTree = new Map([
  ["src/app/booking/[id]/page.tsx", bookerPage],
  ["src/app/booking/[id]/error.tsx", `"use client";\nexport default function E() { window.parent.postMessage({}, "x"); return null; }`],
]);
const copiedFindings = scanBookerBoundaries(copied);
assert(
  copiedFindings.some((f) => /does not render/.test(f.problem)),
  "a boundary that does not render the shared component is caught",
);
assert(
  copiedFindings.some((f) => /announces the crash itself/.test(f.problem)),
  "a boundary that posts to the host on its own is caught",
);

// A boundary in a PARENT segment still catches the page, so it counts.
const parent: SourceTree = new Map([
  ["src/app/booking/[id]/page.tsx", bookerPage],
  ["src/app/booking/error.tsx", sharedBoundary],
]);
assert(
  nearestBoundary(parent, "src/app/booking/[id]/page.tsx") === "src/app/booking/error.tsx",
  "a boundary in a parent segment is the one that catches",
);
assert(scanBookerBoundaries(parent).length === 0, "and a parent boundary rendering the shared component passes");

// A page that does not render the booker is not asked for one.
const other: SourceTree = new Map([["src/app/login/page.tsx", `export default function P() { return null; }`]]);
assert(scanBookerBoundaries(other).length === 0, "a page that is not the booker is out of scope");

finish();
