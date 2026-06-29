// Unit test for hasBlockingBusy — the precise busy-subtraction behind the
// reschedule self-free check (#523). A sub-event-length reschedule overlaps the
// booking's OWN still-present event; excluding exactly that interval must keep
// the move in-place WITHOUT ever falsely freeing a genuinely adjacent conflict
// (which Google's freeBusy may merge into one busy block).
// Run: node --experimental-strip-types scripts/test-freebusy-ignore.ts
import { hasBlockingBusy } from "../src/lib/booking/core.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    failures++;
  } else console.log("ok:", msg);
}

const ms = (s: string) => Date.parse(s);
const at = (h: string) => `2026-06-08T${h}:00.000Z`;
// Own event 19:00–19:20; reschedule to 19:10–19:30 (overlaps it by 10 min).
const own = { start: at("19:00"), end: at("19:20") };
const win = [ms(at("19:10")), ms(at("19:30"))] as const;

// 1. Only the own event is on the calendar -> free in-place.
assert(
  hasBlockingBusy([{ start: at("19:00"), end: at("19:20") }], win[0], win[1], own) === false,
  "own event alone is not a conflict (in-place stays)",
);

// 2. Without the exclusion, the own event reads as busy (the bug being fixed).
assert(
  hasBlockingBusy([{ start: at("19:00"), end: at("19:20") }], win[0], win[1]) === true,
  "no exclusion: own event counts as a conflict (re-routes) — the #523 bug",
);

// 3. A real adjacent event AFTER the own one (Google merges 19:00–19:40) -> the
//    19:20–19:30 part is outside the ignored span, so it must still block.
assert(
  hasBlockingBusy([{ start: at("19:00"), end: at("19:40") }], win[0], win[1], own) === true,
  "adjacent-after event (merged block) still blocks — never falsely freed",
);

// 4. A real adjacent event BEFORE the own one (merged 18:40–19:20): its only
//    overlap with the window is the own-event portion, so it does NOT block.
assert(
  hasBlockingBusy([{ start: at("18:40"), end: at("19:20") }], win[0], win[1], own) === false,
  "adjacent-before event outside the window does not block",
);

// 5. Own event sandwiched between two real events, all merged 18:40–19:40 ->
//    the trailing 19:20–19:30 part blocks.
assert(
  hasBlockingBusy([{ start: at("18:40"), end: at("19:40") }], win[0], win[1], own) === true,
  "own event between two real events still blocks on the trailing conflict",
);

// 6. A separate real event fully inside the window blocks.
assert(
  hasBlockingBusy(
    [
      { start: at("19:00"), end: at("19:20") },
      { start: at("19:25"), end: at("19:28") },
    ],
    win[0],
    win[1],
    own,
  ) === true,
  "a distinct event inside the window blocks even with the own event ignored",
);

// 7. Boundary: a busy block ending exactly at window start does not overlap.
assert(
  hasBlockingBusy([{ start: at("18:50"), end: at("19:10") }], win[0], win[1], own) === false,
  "busy ending exactly at window start is not a conflict (exclusive boundary)",
);

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\nALL PASSED");
