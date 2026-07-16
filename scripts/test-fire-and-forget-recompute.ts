// Repo invariant (#503): the calendar-sync and OOO post-response recomputes must
// NOT regress to a bare `void recomputeBucketsForAgent(...)` float, which
// Cloudflare/OpenNext can drop once the response resolves. They now go through an
// awaited call (sync) or `afterResponse(...)` (OOO). This guard fails the build
// if the float shape reappears in those paths.
//
// The scan logic lives in scripts/lib/scan-fire-and-forget-recompute.ts so it is
// unit-testable. This file exercises it against fixtures (a positive control
// proving the detector still flags the bad shape, so it can't rot into a no-op)
// and against the real source (which must be clean).
// Run: node --experimental-strip-types scripts/test-fire-and-forget-recompute.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scanFireAndForgetRecompute } from "./lib/scan-fire-and-forget-recompute.ts";
import { assert, finish } from "./lib/harness.ts";

const HERE = import.meta.dirname; // scripts/
const ROOT = join(HERE, "..");

// --- positive control: the detector must flag the banned float ----------------
{
  const bad = `void recomputeBucketsForAgent(cal.user_id).catch(() => {});`;
  assert(
    scanFireAndForgetRecompute(bad).length === 1,
    "flags a bare void recomputeBucketsForAgent float",
  );

  // ...and must NOT flag the compliant shapes.
  const awaited = `await recomputeBucketsForAgent(cal.user_id).catch(() => {});`;
  assert(
    scanFireAndForgetRecompute(awaited).length === 0,
    "does not flag an awaited recompute",
  );
  const wrapped = `afterResponse("ooo-recompute", () => recomputeBucketsForAgent(userId));`;
  assert(
    scanFireAndForgetRecompute(wrapped).length === 0,
    "does not flag an afterResponse-wrapped recompute",
  );

  // The deferred every-booking float (a DIFFERENT function) must not be flagged.
  const invalidate = `void recomputeBucketSlotsForToday(bucketCode).catch(() => {});`;
  assert(
    scanFireAndForgetRecompute(invalidate).length === 0,
    "does not flag the deferred invalidateSlots float (recomputeBucketSlotsForToday)",
  );
}

// --- the real source must be clean --------------------------------------------
for (const rel of ["src/lib/google/sync.ts", "src/lib/ooo/service.ts"]) {
  const hits = scanFireAndForgetRecompute(readFileSync(join(ROOT, rel), "utf8"));
  assert(
    hits.length === 0,
    `${rel} has no fire-and-forget recomputeBucketsForAgent float` +
      (hits.length ? ` (line ${hits.map((h) => h.line).join(", ")})` : ""),
  );
}

finish();
