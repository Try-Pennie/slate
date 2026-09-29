// External-Google double-booking detection (#316): after a sync writes an
// agent's gcal busy blocks, find any external Google event that overlaps an
// active Slate booking on that agent (excluding the booking's OWN mirrored
// event), so a silent cross-system double-book becomes a detected, alertable one.
import { findExternalCollisions } from "../src/lib/google/collision.ts";
import { readFileSync } from "node:fs";
import { assert, finish } from "./lib/harness.ts";

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
  assert(c.length === 1 && c[0].bookingId === "bk1" && c[0].gcalEventId === "ext-1", "overlapping external event collides");
}
// The collision carries both windows, so the page can say WHEN the clash is
// rather than handing the reader a bare id.
{
  const c = findExternalCollisions([block("ext-1", 8, 10)], [booking("bk1", "slate-evt", 9)]);
  assert(
    c.length === 1 && c[0].bookingStartMs === T(9) && c[0].eventStartMs === T(8) && c[0].eventEndMs === T(10),
    "a collision carries the call's start and the outside event's window",
  );
}
// The booking's OWN event, mirrored back by sync, is NOT a collision.
{
  const c = findExternalCollisions([block("slate-evt", 9, 10)], [booking("bk1", "slate-evt", 9)]);
  assert(c.length === 0, "the booking's own mirrored gcal event is not a collision");
}
// Non-overlapping external event is fine.
{
  const c = findExternalCollisions([block("ext-1", 11, 12)], [booking("bk1", "slate-evt", 9)]);
  assert(c.length === 0, "non-overlapping external event is not a collision");
}
// Edge-adjacent (back-to-back, no overlap) is fine.
{
  const c = findExternalCollisions([block("ext-1", 10, 11)], [booking("bk1", "slate-evt", 9)]);
  assert(c.length === 0, "an event starting exactly when the booking ends does not collide");
}
// At most one collision reported per booking even with several overlaps.
{
  const c = findExternalCollisions([block("ext-1", 9, 10), block("ext-2", 9, 10)], [booking("bk1", "x", 9)]);
  assert(c.length === 1, "one collision per booking is enough to flag");
}
// Multiple bookings independently checked.
{
  const c = findExternalCollisions(
    [block("ext-1", 9, 10), block("ext-2", 14, 15)],
    [booking("bk1", "s1", 9), booking("bk2", "s2", 12), booking("bk3", "s3", 14)],
  );
  assert(c.length === 2 && c.map((x) => x.bookingId).join(",") === "bk1,bk3", "only the colliding bookings are flagged");
}

// --- An owner reassign is ALLOWED to double book, so it must not page (#2442) ---
//
// The contact owner override (#9) is the one path that books an agent at a time
// they are already busy: the lead goes back to the advisor they already spoke
// with whether or not that advisor is free. It marks the booking
// `allow_double_book`, which is what lets the active slot unique index stack it.
//
// So the overlap it creates is one somebody meant to create, and paging
// engineering about it is an alarm firing on intended behaviour (L36). Observed
// live 2026-09-16: a test owner move onto an advisor holding a seven hour block
// produced this page beside the sales notice (#2372) about the same booking.
// Before the flip it is rare; after it, it is the normal shape of a returning
// lead.
{
  const reassigned = { ...booking("bk-owner", "slate-evt", 9), allowDoubleBook: true };
  const c = findExternalCollisions([block("ext-1", 9, 10)], [reassigned]);
  assert(c.length === 0, "a booking an owner reassign placed on purpose does not page");
}

// The alarm must still fire for an overlap arriving any other way, which is the
// whole reason it exists: verify on book is a best effort live check, so somebody
// can still book an agent directly in Google inside the race window.
{
  const ordinary = { ...booking("bk-ordinary", "slate-evt", 9), allowDoubleBook: false };
  const c = findExternalCollisions([block("ext-1", 9, 10)], [ordinary]);
  assert(c.length === 1 && c[0].bookingId === "bk-ordinary", "an unintended overlap still collides");
}

// A booking with nothing recorded either way is treated as ordinary, never as
// allowed. The flag is what the reassign path WRITES, so its absence is the
// commonest state on the table and must fail toward speaking up.
{
  const c = findExternalCollisions([block("ext-1", 9, 10)], [booking("bk-unset", "slate-evt", 9)]);
  assert(c.length === 1, "a booking with no flag recorded is judged as an ordinary one");
}

// --- The flag has to REACH the judgement, and a pure test cannot see that ---
//
// `findExternalCollisions` is only as quiet as the field it is handed. If the
// bookings read in sync.ts stops selecting `allow_double_book`, every row
// arrives with it undefined, `?? false` makes each one ordinary, and the page
// comes back for every owner reassign with nothing failing anywhere (L3: built
// is not wired). Nothing else drives that query, so this reads the source.
//
// It is a static check and it is worth naming what it cannot do: it proves the
// column is asked for and carried, not that Postgres returned it. The value
// itself is judged by the cases above.
{
  const sync = readFileSync(new URL("../src/lib/google/sync.ts", import.meta.url), "utf8");
  const read = sync.slice(sync.indexOf('.from("bookings")'));
  const select = read.slice(0, read.indexOf("\n\n"));
  assert(
    /\.select\([^)]*allow_double_book/.test(select),
    "the collision scan's bookings read selects allow_double_book",
  );
  assert(
    /allowDoubleBook:\s*b\.allow_double_book/.test(sync),
    "and carries it onto the booking the judgement is given",
  );
}

finish();
