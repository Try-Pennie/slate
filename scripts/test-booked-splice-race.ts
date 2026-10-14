// #3324: the race a booking's splice has to fence.
//
// A splice recomputes only the booked window and leaves `computed_at` alone, because
// the rest of the row is exactly as old as it was. That takes away the protection the
// whole pool refresh had for free: its compute began AFTER the booking, so its newer
// stamp beat any older compute through the compare and swap (#1048). A full compute
// that read busy_blocks before the booking's block existed, and writes after the
// splice, would put the booked time straight back.
//
// The obvious fence, stamping `invalidated_at` so the older compute is REFUSED, was
// measured and rejected: at the load run's sixty bookings a minute, the busiest pool
// takes a booking inside nearly every lane compute (94 percent refused at a four
// second compute, from the production roster), so the lane would almost never land
// and the stale alarm would page. So the fence MERGES instead: the splice records its
// window and the booking's instant in the row, and an older full compute landing
// later keeps its own times everywhere except inside a window spliced after it began,
// where a time stays only if both agree it is free.
//
// Driven against an in memory bucket_slots that evaluates the filters the writers
// really send, interleaving by interleaving.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-booked-splice-race.ts
import { rowProvenance } from "../src/lib/availability/slot-row-writer.ts";
import { markSlotRowsInvalidated, spliceSlotRow, writeSlotRow } from "../src/lib/availability/slot-row-write.ts";
import { shapePrecomputedRow } from "../src/lib/availability/precompute-shape.ts";
import { spliceMetaOf, type SplicePart, type SpliceWindow } from "../src/lib/availability/slot-splice.ts";
import { fakeBucketSlotsTable, type SlotRow } from "./lib/fake-bucket-slots-table.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const T = (hhmm: string) => `2026-10-13T${hhmm}:00.000Z`;
const at = (hhmm: string) => Date.parse(`2026-10-12T${hhmm}:00.000Z`);

// The day's offer before the booking: 14:00 to 15:00 on a 20 minute grid.
const BEFORE = [T("14:00"), T("14:20"), T("14:40"), T("15:00"), T("15:20")];
// The booking takes 14:40, and nobody else is free then.
const BOOKED = T("14:40");
const WINDOW: SpliceWindow = { fromMs: Date.parse(T("14:20")) + 1, lastStartMs: Date.parse(T("15:00")) - 1 };
const WINDOW_ANSWER = { slots: [] as string[] }; // nothing in (14:20, 15:00) is free now

const payload = (slots: string[], extra: Record<string, unknown> = {}) => ({
  bucket: { code: "201" },
  eventType: { duration_min: 20 },
  orgName: "Pennie",
  slots,
  ...extra,
});
const slots = (rows: SlotRow[]) => (rows[0]!.payload as { slots: string[] }).slots;

function table(computedAt = "2026-10-12T09:55:00.000Z") {
  return fakeBucketSlotsTable([
    { bucket_code: "201", payload: payload(BEFORE), computed_at: computedAt, invalidated_at: null },
  ]);
}

const LANE_START_BEFORE_BOOKING = at("10:00");
const BOOKING_COMMIT = at("10:00") + 1500;
const SPLICE_START = at("10:00") + 1600;
const LANE_START_AFTER_BOOKING = at("10:00") + 2000;

// --- an older full compute landing AFTER the splice cannot restore the booked time ---
{
  const t = table();
  eq(
    await spliceSlotRow(t.db, "201", [{ w: WINDOW, judge: WINDOW_ANSWER }], BOOKING_COMMIT, SPLICE_START),
    "spliced",
    "the splice lands",
  );
  assert(!slots(t.rows).includes(BOOKED), "and the booked time is gone");
  eq(t.rows[0]!.computed_at, "2026-10-12T09:55:00.000Z", "without moving computed_at");

  // The lane compute began BEFORE the booking, so it still thinks 14:40 is free, and
  // it also found 16:00 newly free outside the window.
  const laneAnswer = payload([...BEFORE, T("16:00")]);
  eq(await writeSlotRow(t.db, "201", laneAnswer, LANE_START_BEFORE_BOOKING, "push"), "written", "the older compute still lands");
  // #3381: the merged row names the compute that wrote it AND the splice it kept, so a
  // row offering a time nobody is free for can be traced to one or the other.
  eq(
    rowProvenance(t.rows[0]!.payload),
    { writtenBy: "push", spliced: new Date(BOOKING_COMMIT).toISOString() },
    "the merged row names its writer and the splice it kept",
  );
  const s = slots(t.rows);
  assert(!s.includes(BOOKED), "but the booked time stays gone");
  assert(s.includes(T("16:00")), "while its own news outside the window is kept");
  assert(s.includes(T("14:20")) && s.includes(T("15:00")), "and the window's edges, which the splice never judged, are its own");
  eq(t.rows[0]!.computed_at, new Date(LANE_START_BEFORE_BOOKING).toISOString(), "and computed_at describes the full compute");

  // A full compute that began after the booking saw it, so the fence has done its job
  // and is cleared by the next one past it.
  const fresh = payload([T("14:00"), T("14:20"), T("15:00"), T("15:20"), T("16:00")]);
  eq(await writeSlotRow(t.db, "201", fresh, LANE_START_AFTER_BOOKING, "lane"), "written", "a later compute lands");
  eq(slots(t.rows), fresh.slots, "exactly as computed");
  assert(!("splice" in (t.rows[0]!.payload as object)), "and the fence record is gone with it");
}

// --- an older full compute landing BEFORE the splice is spliced over ------------------
{
  const t = table();
  eq(await writeSlotRow(t.db, "201", payload(BEFORE), LANE_START_BEFORE_BOOKING, "lane"), "written", "the lane lands first");
  await spliceSlotRow(t.db, "201", [{ w: WINDOW, judge: WINDOW_ANSWER }], BOOKING_COMMIT, SPLICE_START);
  assert(!slots(t.rows).includes(BOOKED), "and the splice after it still removes the booked time");
}

// --- a full compute landing BETWEEN the splice's read and its write --------------------
{
  const t = table();
  // The lane lands with a time the splice never read (16:00), just before the splice's
  // write. The splice's compare and swap must notice and splice into the NEW row.
  t.beforeNextUpdate(async () => {
    t.rows[0]!.payload = payload([...BEFORE, T("16:00")]);
    t.rows[0]!.computed_at = new Date(LANE_START_BEFORE_BOOKING).toISOString();
  });
  eq(
    await spliceSlotRow(t.db, "201", [{ w: WINDOW, judge: WINDOW_ANSWER }], BOOKING_COMMIT, SPLICE_START),
    "spliced",
    "the splice retries past the write that landed under it",
  );
  assert(!slots(t.rows).includes(BOOKED), "the booked time is gone");
  assert(slots(t.rows).includes(T("16:00")), "and the lane's news is not overwritten by the splice's stale read");
}

// --- two splices racing on one row ---------------------------------------------------
{
  const t = table();
  // A second booking for 15:20 splices in the gap between the first splice's read and
  // its write. Neither may lose the other's removal.
  const second: SpliceWindow = { fromMs: Date.parse(T("15:00")) + 1, lastStartMs: Date.parse(T("15:40")) - 1 };
  t.beforeNextUpdate(async () => {
    eq(
      await spliceSlotRow(t.db, "201", [{ w: second, judge: { slots: [] } }], BOOKING_COMMIT - 500, SPLICE_START - 400),
      "spliced",
      "the second booking's splice lands first",
    );
  });
  await spliceSlotRow(t.db, "201", [{ w: WINDOW, judge: WINDOW_ANSWER }], BOOKING_COMMIT, SPLICE_START);
  const s = slots(t.rows);
  assert(!s.includes(BOOKED), "the first booking's time is gone");
  assert(!s.includes(T("15:20")), "and so is the second's: neither splice undid the other");
}
{
  // A splice whose compute began BEFORE another booking it overlaps cannot know about
  // it, so it is told to compute again rather than splice a stale answer in.
  const t = table();
  await spliceSlotRow(t.db, "201", [{ w: WINDOW, judge: WINDOW_ANSWER }], BOOKING_COMMIT, SPLICE_START);
  eq(
    await spliceSlotRow(t.db, "201", [{ w: WINDOW, judge: { slots: [BOOKED] } }], BOOKING_COMMIT - 2000, BOOKING_COMMIT - 1000),
    "recompute",
    "an overlapping splice computed before the other booking committed is refused",
  );
  assert(!slots(t.rows).includes(BOOKED), "and the time stays gone");
}

// --- a settings save keeps its own meaning ---------------------------------------------
{
  const t = table();
  await spliceSlotRow(t.db, "201", [{ w: WINDOW, judge: WINDOW_ANSWER }], BOOKING_COMMIT, SPLICE_START);
  await markSlotRowsInvalidated(t.db, LANE_START_AFTER_BOOKING);
  eq(
    await writeSlotRow(t.db, "201", payload(BEFORE), LANE_START_BEFORE_BOOKING, "lane"),
    "invalidated",
    "a compute that straddles a save is still refused, fence or no fence (#3118)",
  );
  eq(
    await spliceSlotRow(t.db, "201", [{ w: WINDOW, judge: WINDOW_ANSWER }], BOOKING_COMMIT, SPLICE_START),
    "recompute",
    "and a splice computed before the save is told to compute again",
  );
}

// --- what a lead is served never carries the fence record -------------------------------
{
  const t = table();
  await spliceSlotRow(t.db, "201", [{ w: WINDOW, judge: WINDOW_ANSWER }], BOOKING_COMMIT, SPLICE_START);
  const served = shapePrecomputedRow(t.rows[0]!);
  assert(served !== null && !("splice" in served), "the row read back as slots has no fence record on it");
}

// --- a move: the old time re-offered, the new one taken, in one write (#3334) ----------
//
// A reschedule or reassign frees one window and takes another. The freed window is
// re-judged through the same predicate and, unlike a create's window, the answer may
// PUT TIMES BACK: the booking that held them has gone. Inside it the fresh answer is
// authoritative, with one limit: a time goes back only on a day the list already
// offers, because the row was trimmed to its first bookable days (#1326) and opening
// a day the trim left out would stretch it past the horizon.
const HELD = T("14:40"); // the move's old time, withheld while the booking held it
const MOVED_TO = T("15:20"); // its new time
const MOVED_ROW = [T("14:00"), T("14:20"), T("15:00"), T("15:20")];
const FREED: SpliceWindow = { fromMs: Date.parse(T("14:20")) + 1, lastStartMs: Date.parse(T("15:00")) - 1 };
const TAKEN: SpliceWindow = { fromMs: Date.parse(T("15:00")) + 1, lastStartMs: Date.parse(T("15:40")) - 1 };
// The taken window FIRST: a guard that consulted only the first window would miss a
// fence on the freed one.
const movedParts = (freedSlots: string[] = [HELD]): SplicePart[] => [
  { w: TAKEN, judge: { slots: [] } },
  { w: FREED, judge: { slots: freedSlots }, reoffer: true },
];
const movedTable = (rowSlots: string[] = MOVED_ROW, extra: Record<string, unknown> = {}) =>
  fakeBucketSlotsTable([
    { bucket_code: "201", payload: payload(rowSlots, extra), computed_at: "2026-10-12T09:55:00.000Z", invalidated_at: null },
  ]);
{
  const t = movedTable();
  eq(await spliceSlotRow(t.db, "201", movedParts(), BOOKING_COMMIT, SPLICE_START), "spliced", "a move's splice lands");
  eq(slots(t.rows), [T("14:00"), T("14:20"), HELD, T("15:00")], "the old time is back, in order, and the new one is gone");
  eq(t.statements.update, 1, "both windows land in ONE compare and swap");
  eq(t.rows[0]!.computed_at, "2026-10-12T09:55:00.000Z", "without moving computed_at");
  const fences = spliceMetaOf(t.rows[0]!.payload)?.windows ?? [];
  eq(fences.length, 2, "and a fence is recorded for each window");
}
{
  // Inside the freed window the fresh answer is authoritative both ways: 14:40 comes
  // back and 15:00, taken meanwhile (say a Google event), goes. The list is the same
  // LENGTH as before, so a splice that judged "changed" by length would skip it.
  const wide: SpliceWindow = { fromMs: Date.parse(T("14:00")) + 1, lastStartMs: Date.parse(T("15:20")) - 1 };
  const t = movedTable();
  eq(
    await spliceSlotRow(t.db, "201", [{ w: wide, judge: { slots: [T("14:20"), HELD] }, reoffer: true }], BOOKING_COMMIT, SPLICE_START),
    "spliced",
    "a re-offer that adds one time and drops another is written",
  );
  eq(slots(t.rows), [T("14:00"), T("14:20"), HELD, T("15:20")], "with the fresh answer inside the window");
}
{
  // The freed time falls on a day this row offers nothing on (the booking held its
  // only time, or the cap had closed it, or the trim left it out). Re-offering it
  // would open a day the stored strip does not have.
  const nextDay = (hhmm: string) => `2026-10-14T${hhmm}:00.000Z`;
  const w: SpliceWindow = { fromMs: Date.parse(nextDay("14:20")) + 1, lastStartMs: Date.parse(nextDay("15:00")) - 1 };
  const t = movedTable([T("14:00")]);
  eq(
    await spliceSlotRow(t.db, "201", [{ w, judge: { slots: [nextDay("14:40")] }, reoffer: true }], BOOKING_COMMIT, SPLICE_START),
    "unchanged",
    "a re-offer never opens a day the list does not already offer",
  );
  eq(slots(t.rows), [T("14:00")], "the row is as it was");
  eq(t.statements.update, 0, "and nothing was written");
}
{
  // Each list keeps to its own days (#2842): the second list puts the time back only
  // where it already offers that day, and an absent one stays absent (unknown).
  const t = movedTable([T("14:00"), T("14:20"), T("15:00")], { slotsWithoutLow: [T("14:00")] });
  await spliceSlotRow(
    t.db,
    "201",
    [{ w: FREED, judge: { slots: [HELD], slotsWithoutLow: [HELD] }, reoffer: true }],
    BOOKING_COMMIT,
    SPLICE_START,
  );
  const p = t.rows[0]!.payload as { slots: string[]; slotsWithoutLow?: string[] };
  eq(p.slotsWithoutLow, [T("14:00"), HELD], "the second list re-offers on a day it already offers");
  const none = movedTable([T("14:00"), T("14:20"), T("15:00")], { slotsWithoutLow: [] });
  await spliceSlotRow(
    none.db,
    "201",
    [{ w: FREED, judge: { slots: [HELD], slotsWithoutLow: [HELD] }, reoffer: true }],
    BOOKING_COMMIT,
    SPLICE_START,
  );
  eq((none.rows[0]!.payload as { slotsWithoutLow?: string[] }).slotsWithoutLow, [], "and opens no day in an empty one");
  const absent = movedTable([T("14:00"), T("14:20"), T("15:00")]);
  await spliceSlotRow(absent.db, "201", [{ w: FREED, judge: { slots: [HELD], slotsWithoutLow: [HELD] }, reoffer: true }], BOOKING_COMMIT, SPLICE_START);
  assert(!("slotsWithoutLow" in (absent.rows[0]!.payload as object)), "while an absent second list stays absent");
}
{
  // Another booking took a time in the freed window after the move's compute began,
  // and its splice has landed. The move's answer cannot know about it, so it is told
  // to compute again rather than put that time back on offer.
  const t = movedTable();
  const other: SpliceWindow = { fromMs: Date.parse(T("14:00")) + 1, lastStartMs: Date.parse(T("14:40")) - 1 };
  eq(
    await spliceSlotRow(t.db, "201", [{ w: other, judge: { slots: [] } }], BOOKING_COMMIT, SPLICE_START),
    "spliced",
    "the other booking's splice lands first",
  );
  eq(
    await spliceSlotRow(t.db, "201", movedParts([T("14:20"), HELD]), BOOKING_COMMIT + 100, BOOKING_COMMIT - 1000),
    "recompute",
    "a move whose freed window overlaps a booking fenced after its compute began computes again",
  );
  assert(!slots(t.rows).includes(T("14:20")), "and the other booking's time is not put back");
}
{
  // An older full compute, begun before the move, lands after the move's splice.
  const t = movedTable();
  await spliceSlotRow(t.db, "201", movedParts(), BOOKING_COMMIT, SPLICE_START);
  assert(slots(t.rows).includes(HELD), "the move re-offered its old time");
  // That compute read the booking at its OLD time: 15:20 free, 14:40 held.
  const laneAnswer = payload([...MOVED_ROW, T("16:00")]);
  eq(await writeSlotRow(t.db, "201", laneAnswer, LANE_START_BEFORE_BOOKING, "lane"), "written", "the older compute still lands");
  const s = slots(t.rows);
  assert(!s.includes(MOVED_TO), "but the moved booking's NEW time stays gone");
  assert(s.includes(T("16:00")), "while its news outside both windows is kept");
  // Inside the freed window the merge keeps a time only where both agree, so the
  // older compute's withholding wins until the next compute: the safe side, since
  // nothing can show that compute knew the time was free.
  assert(!s.includes(HELD), "and the old time is withheld again, the safe direction");
  const fresh = payload([T("14:00"), T("14:20"), HELD, T("15:00"), T("16:00")]);
  eq(await writeSlotRow(t.db, "201", fresh, LANE_START_AFTER_BOOKING, "lane"), "written", "until a compute past the move lands");
  assert(slots(t.rows).includes(HELD), "which offers it again");
}

// --- failures ----------------------------------------------------------------------
{
  const t = table();
  eq(
    await spliceSlotRow(t.db, "999", [{ w: WINDOW, judge: WINDOW_ANSWER }], BOOKING_COMMIT, SPLICE_START),
    "no-row",
    "a code with no row is not created by a splice",
  );
  eq(t.rows.length, 1, "nothing was inserted");
}
{
  // A read error leaves the row as it was, and the lane still lands over it.
  const t = table();
  const snapshot = JSON.stringify(t.rows);
  const broken = {
    from: (name: string) => {
      const real = (t.db as unknown as { from(n: string): Record<string, unknown> }).from(name);
      return {
        ...real,
        select: () => {
          const b: Record<string, unknown> = {
            eq: () => b,
            maybeSingle: async () => ({ data: null, error: { message: "connection reset" } }),
          };
          return b;
        },
      };
    },
  };
  eq(
    await spliceSlotRow(broken as never, "201", [{ w: WINDOW, judge: WINDOW_ANSWER }], BOOKING_COMMIT, SPLICE_START),
    "failed",
    "a splice that cannot read the row fails",
  );
  eq(JSON.stringify(t.rows), snapshot, "and leaves it exactly as it was");
  const fresh = payload([T("14:00"), T("14:20"), T("15:00"), T("15:20")]);
  eq(await writeSlotRow(t.db, "201", fresh, LANE_START_AFTER_BOOKING, "lane"), "written", "the lane's next compute covers it");
  assert(!slots(t.rows).includes(BOOKED), "and the booked time is gone that way instead");
}
{
  // A row that keeps changing under the splice is given up on, not spun on forever.
  const t = table();
  let n = 0;
  const churn = async () => {
    n++;
    t.rows[0]!.computed_at = new Date(at("09:00") + n).toISOString();
    t.beforeNextUpdate(churn);
  };
  t.beforeNextUpdate(churn);
  const snapshot = slots(t.rows);
  eq(
    await spliceSlotRow(t.db, "201", [{ w: WINDOW, judge: WINDOW_ANSWER }], BOOKING_COMMIT, SPLICE_START),
    "failed",
    "a splice that loses every compare and swap fails",
  );
  assert(n <= 3, `after a bounded number of attempts (${n})`);
  eq(slots(t.rows), snapshot, "leaving the slots as they were");
}

finish();
