// Unit test for the cross-bucket smoke scenario's slot choice (#1489).
//
// The bug (three identical canary pages in ten days: runs 31572395842,
// 31732256039, 31778492501): scenario [2] booked `slotsA[2]` in SMOKE and
// `slotsB[0]` in SMOKE2 and ASSUMED those two instants differ. They come from two
// different reads of the same live availability cache: slotsA is fetched once at
// the top of the run, slotsB fresh inside the scenario. SMOKE2 has a single member
// (smoketest@), so while scenario [1]'s booking is still cached, SMOKE2's list
// loses the two leading slots a 20-minute event covers and its head lands on
// exactly `slotsA[2]`.
//
// The healthy spacing is zero margin by construction: every passing run reads
// SMOKE@12:20 | SMOKE2@12:00, two 10-minute slots apart, which is exactly one
// event length. So one stale read closes the gap precisely, both bookings land on
// the same instant, the API dedupes (correct and documented, person-dedupe.ts:122
// compares instants only and never the bucket), and two checks fail.
//
// The fix: choose the SMOKE2 start relative to the SMOKE start actually used,
// with a margin wide enough that no event length can overlap, and refuse with a
// named reason rather than returning a colliding slot.
//
// Run: node --experimental-strip-types scripts/test-smoke-cross-bucket-slot.ts
import { assert, eq, finish } from "./lib/harness.ts";
import { chooseCrossBucketSlot, CROSS_BUCKET_MIN_GAP_MS } from "./lib/smoke-cross-bucket-slot.ts";

/** The exact production shape: a 10-minute grid from 12:00 UTC. */
function grid(count: number, fromIso = "2026-08-14T12:00:00.000Z"): string[] {
  const base = Date.parse(fromIso);
  return Array.from({ length: count }, (_, i) => new Date(base + i * 10 * 60_000).toISOString());
}

// --- The regression: B's head IS the slot already booked in A -------------------
// This is the live shape of run 31778492501: A booked 12:20, B's fresh list starts
// at 12:20 because the earlier scenario's 12:00 booking still blocks 12:00/12:10.

const collided = chooseCrossBucketSlot(grid(20, "2026-08-14T12:20:00.000Z"), "2026-08-14T12:20:00.000Z");
assert(collided.ok, "a colliding list still yields a usable slot further down");
assert(
  collided.ok && collided.start !== "2026-08-14T12:20:00.000Z",
  "never returns the SAME instant already booked in the other bucket (the dedupe collision)",
);
eq(
  collided.ok ? collided.start : "",
  "2026-08-14T13:20:00.000Z",
  "picks the first slot a full gap past the booked instant",
);

// --- The healthy shape still picks an early slot --------------------------------
// A booked 12:20, B's list starts at 12:00. 12:00 is only 20 minutes away, inside
// the margin, so it is skipped: an earlier slot whose event overlaps A's would hit
// NO_ELIGIBLE_AGENTS, because the cross-bucket move CREATES the new booking before
// cancelling the old one and SMOKE2's only agent is the one holding it.

const healthy = chooseCrossBucketSlot(grid(20), "2026-08-14T12:20:00.000Z");
eq(
  healthy.ok ? healthy.start : "",
  "2026-08-14T13:20:00.000Z",
  "skips a nearby earlier slot whose event would overlap the booking in the other bucket",
);

// --- A slot a full gap EARLIER is acceptable ------------------------------------

const earlier = chooseCrossBucketSlot(grid(20), "2026-08-14T13:30:00.000Z");
eq(
  earlier.ok ? earlier.start : "",
  "2026-08-14T12:00:00.000Z",
  "an earlier slot is fine once it clears the margin (the gap is symmetric)",
);

// --- Failure paths: refuse with a reason, never a colliding slot -----------------

const empty = chooseCrossBucketSlot([], "2026-08-14T12:20:00.000Z");
assert(!empty.ok, "an empty slot list is a refusal, not a pick");
assert(
  !empty.ok && /no open slots/i.test(empty.reason),
  `empty list names the cause (got: ${empty.ok ? "" : empty.reason})`,
);

// Every slot inside the margin: refuse and NAME the nearest one, so a reader can
// tell a too-thin window apart from a genuine dedupe regression without querying
// production (which is what diagnosing #1489 actually took).
const tooThin = chooseCrossBucketSlot(grid(4), "2026-08-14T12:20:00.000Z");
assert(!tooThin.ok, "a list entirely inside the margin is a refusal");
assert(
  !tooThin.ok && tooThin.reason.includes("2026-08-14T12:20:00.000Z"),
  `a too-thin window names the booked instant it had to clear (got: ${tooThin.ok ? "" : tooThin.reason})`,
);
assert(
  !tooThin.ok && /60 min/i.test(tooThin.reason),
  `a too-thin window names the margin it needed (got: ${tooThin.ok ? "" : tooThin.reason})`,
);

// An unreadable stamp must never compare its way onto the permissive side (L50):
// Date.parse returns NaN and every comparison with NaN is false, so an unguarded
// `Math.abs(b - a) >= gap` would REJECT a bad B slot (safe) but ACCEPT any slot
// when A itself is unreadable (unsafe: it would then book a colliding instant).
const badAnchor = chooseCrossBucketSlot(grid(20), "not-a-timestamp");
assert(!badAnchor.ok, "an unreadable booked instant refuses rather than accepting any slot");
assert(
  !badAnchor.ok && /unreadable/i.test(badAnchor.reason),
  `an unreadable anchor names the cause (got: ${badAnchor.ok ? "" : badAnchor.reason})`,
);

const withGarbage = chooseCrossBucketSlot(
  ["", "not-a-timestamp", "2026-08-14T13:20:00.000Z"],
  "2026-08-14T12:20:00.000Z",
);
eq(
  withGarbage.ok ? withGarbage.start : "",
  "2026-08-14T13:20:00.000Z",
  "skips unreadable candidate slots instead of returning one",
);

// --- The margin has to be wider than any event the smoke buckets can book -------
// 20 minutes is the seeded SMOKE event length; the margin exists so no event
// length in play can overlap. Pinning it stops the constant being quietly narrowed
// back toward the zero margin that caused #1489.
assert(
  CROSS_BUCKET_MIN_GAP_MS >= 60 * 60_000,
  `the cross-bucket margin is at least an hour (got ${CROSS_BUCKET_MIN_GAP_MS}ms)`,
);

finish();
