// Repo invariant (#1044): docs/api.md documents every HTTP route, and names no route
// that does not exist.
//
// The file's own first lines call it the single authoritative reference for every
// endpoint. Nothing held it to that: the guarded-docs pattern covers DEPLOY.md and the
// README, and this file had no guard at all. Measured on 2026-09-01 it was missing 20
// of 51 routes and 10 of the 21 cron lanes, while still making the claim, which is
// worse than having no such document: a reader checks it, does not find an endpoint,
// and concludes the endpoint does not exist.
//
// Both directions are checked. A one-directional comparison is satisfied by whichever
// list is the superset, and each direction catches a different mistake: a new endpoint
// shipping undocumented, and a deleted endpoint leaving behind an entry that reads as
// coverage of something real.
//
// Run: node --experimental-strip-types scripts/test-api-doc-coverage.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  scanApiDocCoverage,
  documentedPaths,
  routePathOf,
} from "./lib/scan-api-doc-coverage.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const API_DIR = "src/app/api";
const DOC = "docs/api.md";

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...routeFiles(path));
    else if (entry === "route.ts") out.push(path);
  }
  return out;
}

const files = routeFiles(API_DIR);
const markdown = readFileSync(DOC, "utf8");

// --- the enumeration reached something ---------------------------------------
// A scan that found no routes reports the same empty result as a fully documented
// tree, and the enumeration is the fragile half: it reads the filesystem (L98).
assert(files.length > 40, `found the api tree (${files.length} route files)`);
assert(markdown.length > 1000, `read ${DOC} (${markdown.length} chars)`);

// --- the doc and the tree agree, both ways -----------------------------------
const { undocumented, stale } = scanApiDocCoverage(files, markdown);
assert(
  undocumented.length === 0,
  undocumented.length === 0
    ? "every route is named in docs/api.md"
    : `undocumented in ${DOC}: ${undocumented.join(", ")}`,
);
assert(
  stale.length === 0,
  stale.length === 0
    ? "every path the doc names exists in the tree"
    : `${DOC} names paths no route serves: ${stale.join(", ")}`,
);

// --- positive controls -------------------------------------------------------
eq(
  routePathOf("src/app/api/bookings/[token]/cancel/route.ts"),
  "/api/bookings/[token]/cancel",
  "a route's path comes from its position on disk, [param] kept verbatim",
);
eq(routePathOf("src/lib/whatever.ts"), "", "a file outside the api tree has no route path");

{
  // A wildcard does NOT cover the lanes beneath it. This is the control that matters
  // most, because that wildcard is exactly how ten cron lanes went unnamed: the line
  // read as though the family were documented.
  const res = scanApiDocCoverage(
    ["src/app/api/cron/sync/route.ts"],
    "we run `GET /api/cron/*` on a schedule",
  );
  eq(res.undocumented.length, 1, "a wildcard does not document the lanes under it");
  eq(res.stale.length, 0, "and the wildcard itself is not reported as stale");
}
{
  const res = scanApiDocCoverage(["src/app/api/health/route.ts"], "`GET /api/health` is liveness");
  eq(res.undocumented.length, 0, "a documented route passes");
  eq(res.stale.length, 0, "and nothing is stale");
}
{
  const res = scanApiDocCoverage([], "`GET /api/gone` used to exist");
  eq(res.stale.length, 1, "a documented path with no route is reported stale");
}
{
  // Punctuation hanging off a path in prose must not hide the path.
  const found = documentedPaths("see `/api/health`, and /api/routing.");
  assert(found.has("/api/health") && found.has("/api/routing"), "trailing punctuation is trimmed");
}

// --- the real-file overlay ---------------------------------------------------
// The fixtures above are shaped by the same hand that wrote the scanner. This control
// takes the REAL doc and removes one real route's mentions, which must be caught.
{
  const victim = "/api/availability";
  assert(markdown.includes(victim), "the real doc names the availability route");
  const stripped = markdown.split(victim).join("/api/REMOVED-BY-THE-CONTROL");
  const res = scanApiDocCoverage(files, stripped);
  assert(
    res.undocumented.includes(victim),
    "removing a route from the real doc is caught and named",
  );
}

finish();
