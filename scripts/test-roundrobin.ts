// Tests for applyFallback (bucket fallback routing). The ordering logic moved to
// per-bucket equal-share — see scripts/test-bucket-share.ts.
// Run: node --experimental-strip-types scripts/test-roundrobin.ts
import { applyFallback } from "../src/lib/availability/roundrobin.ts";
import { assert, finish } from "./lib/harness.ts";

// --- applyFallback ---
assert(
  JSON.stringify(applyFallback(["a", "b"], "f", true)) === JSON.stringify({ ids: ["a", "b"], fallbackApplied: false }),
  "non-empty matched pool is used as-is (no fallback)",
);
assert(
  JSON.stringify(applyFallback([], "f", true)) === JSON.stringify({ ids: ["f"], fallbackApplied: true }),
  "empty pool with an ELIGIBLE fallback routes to the fallback agent",
);
assert(
  JSON.stringify(applyFallback([], null, true)) === JSON.stringify({ ids: [], fallbackApplied: false }),
  "empty pool with no fallback stays empty",
);

// applyFallback drops an INELIGIBLE fallback agent (#266): a bucket's
// fallback_user_id can point at an agent who is non-bookable or deactivated;
// routing must NOT hand a booking to them just because the matched pool is empty.
assert(
  JSON.stringify(applyFallback([], "f", false)) === JSON.stringify({ ids: [], fallbackApplied: false }),
  "empty pool with an INELIGIBLE fallback routes to nobody",
);

finish();
