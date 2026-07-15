// Standing performance guard (#240): the /api/availability request handler must
// stay on the cheap cached read path and never reach the expensive live compute
// (the multi-agent availability calculation) or a live Google call.
//
// The deterministic "a warm read never recomputes" invariant is already locked at
// the core (scripts/test-precompute-core.ts) and the cache key is pinned
// (scripts/test-slot-cache-key.ts). What nothing caught was a regression ABOVE
// the core: a quiet edit that adds a live Google import or calls getBucketSlots()
// (the live compute) directly in the route handler, reintroducing the
// multi-hundred-ms recompute on the booker's hot path. This scans the route
// source and fails if it reaches the live path instead of the cache wrapper.
//
// Note: slot-cache.ts legitimately imports getBucketSlots as the bounded
// fail-open `compute` dep, so the scan targets the ROUTE handler, which must only
// ever consume getBucketSlotsWithFallback.
// Run: node --experimental-strip-types scripts/test-availability-hot-path.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");
const ROUTE = join(ROOT, "src/app/api/availability/route.ts");

/** Ways the request handler could slip off the cached hot path onto a live call. */
export function hotPathViolations(src: string): string[] {
  const v: string[] = [];
  if (/from\s+["']@\/lib\/google/.test(src)) v.push("imports @/lib/google (a live Google call on the request path)");
  // getBucketSlots( is the live multi-agent compute. \bgetBucketSlots\( does NOT
  // match getBucketSlotsWithFallback( (the cheap cache wrapper), which is fine.
  if (/\bgetBucketSlots\(/.test(src)) v.push("calls getBucketSlots() directly (the live multi-agent compute)");
  if (/\bfreeBusy\b/.test(src)) v.push("references freeBusy (a live Google availability call)");
  return v;
}

const routeSrc = readFileSync(ROUTE, "utf8");

// The real route is clean and routes through the cache wrapper.
const found = hotPathViolations(routeSrc);
assert(found.length === 0, `availability route stays on the cached hot path${found.length ? ` [${found.join("; ")}]` : ""}`);
assert(
  /getBucketSlotsWithFallback\(/.test(routeSrc),
  "availability route reads through the getBucketSlotsWithFallback cache wrapper",
);

// Positive control: a handler that reaches live Google / the live compute MUST be
// flagged, so this guard can't rot into a no-op that verifies nothing.
const badGoogle = `import { listFreeBusy } from "@/lib/google/freebusy";\nexport async function GET() { return listFreeBusy(); }`;
const badCompute = `import { getBucketSlots } from "@/lib/availability/service";\nconst r = getBucketSlots("411", "a", "b");`;
assert(hotPathViolations(badGoogle).length > 0, "positive control: a live Google import is flagged");
assert(hotPathViolations(badCompute).length > 0, "positive control: a direct getBucketSlots() call is flagged");

finish();
