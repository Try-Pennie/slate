// Pure rotation logic for the bounded self-heal sweeps (#512).
//
// Each sweep scans at most `limit` rows per tick. With more matching rows than
// the cap, a fixed scan would never look past the first page, so a tail row that
// genuinely lost its busy_block could go unhealed forever. nextScanOffset cycles
// a persisted offset across ticks so every row is covered within ceil(N/limit)
// ticks, while leaving the common case (backlog within one page) on offset 0.
// Run: node --experimental-strip-types scripts/test-selfheal-rotation.ts
import { nextScanOffset } from "../src/lib/booking/scan-rotation.ts";
import { assert, finish } from "./lib/harness.ts";

const LIMIT = 200;

// Common case: fewer matching rows than the cap. The scan saw everything, so the
// offset stays at 0 and behavior is identical to the pre-#512 fixed scan.
assert(nextScanOffset(0, 0, LIMIT) === 0, "an empty scan stays at offset 0");
assert(nextScanOffset(0, 5, LIMIT) === 0, "a short page (backlog under the cap) stays at offset 0");
assert(nextScanOffset(0, LIMIT - 1, LIMIT) === 0, "a page one under the cap stays at offset 0");

// A full page means there may be more behind it: advance to the next window.
assert(nextScanOffset(0, LIMIT, LIMIT) === LIMIT, "a full first page advances to the next window");
assert(nextScanOffset(LIMIT, LIMIT, LIMIT) === 2 * LIMIT, "a full second page advances again");

// A short page at a non-zero offset means the end is reached: wrap back to 0 so
// the next cycle re-scans the priority page instead of running off the end.
assert(nextScanOffset(LIMIT, 3, LIMIT) === 0, "a short page past offset 0 wraps back to 0");
assert(nextScanOffset(2 * LIMIT, 0, LIMIT) === 0, "an empty page past the end wraps back to 0");

// Exact-multiple boundary: a page that exactly fills the cap advances, and the
// following empty page wraps. This must terminate, never advance forever.
{
  // Simulate N = 400 rows, limit 200: offsets visited across ticks.
  const N = 400;
  const rowsAt = (off: number) => Math.max(0, Math.min(LIMIT, N - off));
  const seen: number[] = [];
  let off = 0;
  for (let tick = 0; tick < 6; tick++) {
    seen.push(off);
    off = nextScanOffset(off, rowsAt(off), LIMIT);
  }
  assert(seen.includes(0) && seen.includes(200), "N=400 covers offset 0 and 200 across ticks");
  assert(seen.every((o) => o <= 400), "the offset never runs unbounded past the row count");
  // It cycles: 0 -> 200 -> (offset 400 gives 0 rows) -> 0 ...
  assert(seen.slice(0, 4).join(",") === "0,200,400,0", "the cycle is 0,200,400,wrap");
}

// A full page whose true tail is an exact multiple still terminates: offset N
// yields 0 rows and resets, so it can never advance past the data indefinitely.
assert(nextScanOffset(400, 0, LIMIT) === 0, "an empty page at an exact-multiple offset resets");

finish();
