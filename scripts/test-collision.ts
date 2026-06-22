// External-Google double-booking detection (#316): after a sync writes an
// agent's gcal busy blocks, find any external Google event that overlaps an
// active Slate booking on that agent (excluding the booking's OWN mirrored
// event), so a silent cross-system double-book becomes a detected, alertable one.
import { findExternalCollisions } from "../src/lib/google/collision.ts";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error("FAIL:", msg);
    failed++;
  } else console.log("ok:", msg);
};

const T = (h: number) => Date.parse(`2026-06-20T${String(h).padStart(2, "0")}:00:00Z`);
const booking = (id: string, gcalEventId: string | null, h: number) => ({
  id,
  gcalEventId,
  startMs: T(h),
  endMs: T(h + 1),
});
const block = (gcalEventId: string | null, startH: number, endH: number) => ({
  gcalEventId,
  startMs: T(startH),
  endMs: T(endH),
});

// An external event (different gcal id) overlapping a Slate booking is a collision.
{
  const c = findExternalCollisions([block("ext-1", 9, 10)], [booking("bk1", "slate-evt", 9)]);
  ok(c.length === 1 && c[0].bookingId === "bk1" && c[0].gcalEventId === "ext-1", "overlapping external event collides");
}
// The booking's OWN event, mirrored back by sync, is NOT a collision.
{
  const c = findExternalCollisions([block("slate-evt", 9, 10)], [booking("bk1", "slate-evt", 9)]);
  ok(c.length === 0, "the booking's own mirrored gcal event is not a collision");
}
// Non-overlapping external event is fine.
{
  const c = findExternalCollisions([block("ext-1", 11, 12)], [booking("bk1", "slate-evt", 9)]);
  ok(c.length === 0, "non-overlapping external event is not a collision");
}
// Edge-adjacent (back-to-back, no overlap) is fine.
{
  const c = findExternalCollisions([block("ext-1", 10, 11)], [booking("bk1", "slate-evt", 9)]);
  ok(c.length === 0, "an event starting exactly when the booking ends does not collide");
}
// At most one collision reported per booking even with several overlaps.
{
  const c = findExternalCollisions([block("ext-1", 9, 10), block("ext-2", 9, 10)], [booking("bk1", "x", 9)]);
  ok(c.length === 1, "one collision per booking is enough to flag");
}
// Multiple bookings independently checked.
{
  const c = findExternalCollisions(
    [block("ext-1", 9, 10), block("ext-2", 14, 15)],
    [booking("bk1", "s1", 9), booking("bk2", "s2", 12), booking("bk3", "s3", 14)],
  );
  ok(c.length === 2 && c.map((x) => x.bookingId).join(",") === "bk1,bk3", "only the colliding bookings are flagged");
}

console.log(failed === 0 ? "\nALL PASSED" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
