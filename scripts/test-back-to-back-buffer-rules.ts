// #3040: why same advisor bookings landed back to back, reproduced.
//
// Production held 57 pairs of Slate bookings on one advisor with ZERO minutes
// between them (for example a 16:00 and a 16:20 call on 2026-10-03), none carrying
// allow_double_book. Measured 2026-10-20, every one of those pairs was CREATED
// between 2026-09-30 19:41Z and 2026-10-02 13:25Z, and not one since, across
// eighteen days of steady booking volume. The buffers on the Senior Loan Advisor
// Call were 0 before and 0 after until they were set to 10 and 10 by hand on the
// morning of 2026-10-02 (#2989's PR body, #2992). So the pairs were booked while the
// rule that forbids them did not exist; no path bypassed it.
//
// This suite runs the REAL slot predicate over the 2026-10-03 case in both states
// of the event type row: as stored when the pairs were booked it offers 16:20 right
// after a 16:00 call, and as stored now it refuses every start closer than ten
// minutes. The read window the confirm and the candidate read use (bufferedWindow)
// is checked the same way, since a window that stops at the call's own minutes
// cannot see a booking that ends exactly as the new call starts (#2989, #3273).
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-back-to-back-buffer-rules.ts
import {
  computeBucketSlots,
  freeMembersForSlot,
  type MemberAvailability,
  type WorkingRule,
} from "../src/lib/availability/compute.ts";
import { bufferedWindow } from "../src/lib/booking/buffered-window.ts";
import { assert, finish } from "./lib/harness.ts";

const MIN = 60_000;
const tz = "America/New_York";
const ALL_DAY_EVERY_DAY: WorkingRule[] = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
  weekday,
  start_minute: 0,
  end_minute: 1440,
}));

// The earlier call of the pair, as the booking write through stores it: one slate
// busy block over the call's own minutes (measured: all 836 active bookings carry
// exactly one, with the booking's own window and advisor).
const booked = { start: Date.parse("2026-10-03T16:00:00.000Z"), end: Date.parse("2026-10-03T16:20:00.000Z") };
const advisor: MemberAvailability = {
  userId: "advisor",
  timezone: tz,
  rules: ALL_DAY_EVERY_DAY,
  busy: [booked],
  bookingStartsMs: [booked.start],
};

/** The Senior Loan Advisor Call row, with the buffers it held at a given time. */
function eventTypeRow(buffer: number) {
  return { duration_min: 20, buffer_before_min: buffer, buffer_after_min: buffer, slot_interval_min: 10 };
}

function inputsFor(row: ReturnType<typeof eventTypeRow>) {
  return {
    durationMin: row.duration_min,
    bufferBeforeMin: row.buffer_before_min,
    bufferAfterMin: row.buffer_after_min,
    minNoticeMin: 0,
    dailyCap: null,
    slotIntervalMin: row.slot_interval_min,
    businessHours: { zone: tz, rules: ALL_DAY_EVERY_DAY, exceptions: [] },
    // Days before the call, so minimum notice never decides anything here.
    nowMs: Date.parse("2026-10-01T22:25:00.000Z"),
  };
}

const from = "2026-10-03T15:00:00.000Z";
const to = "2026-10-03T18:00:00.000Z";
const at = (hhmm: string) => `2026-10-03T${hhmm}:00.000Z`;

/** Minutes between a start's call and the booked call, on whichever side it sits. */
function gapMin(startIso: string, durationMin: number): number {
  const s = Date.parse(startIso);
  const e = s + durationMin * MIN;
  if (e <= booked.start) return (booked.start - e) / MIN;
  if (s >= booked.end) return (s - booked.end) / MIN;
  return -1;
}

const overlaps = ([f, t]: [string, string]) => Date.parse(f) < booked.end && Date.parse(t) > booked.start;

// 1. As stored when the pairs were booked (0 and 0): the offer, the candidate judge
//    and the confirm's read window all admit 16:20, so the pair was the rule working.
{
  const row = eventTypeRow(0);
  const offered = computeBucketSlots({ ...inputsFor(row), members: [advisor], from, to });
  assert(offered.includes(at("16:20")), "buffers 0: 16:20 is offered right after the 16:00 call");
  assert(offered.includes(at("15:40")), "buffers 0: 15:40 is offered ending right as the 16:00 call starts");
  assert(
    freeMembersForSlot([advisor], inputsFor(row), Date.parse(at("16:20"))).includes("advisor"),
    "buffers 0: the candidate judge reads the advisor as free at 16:20",
  );
  assert(
    !overlaps(bufferedWindow(row, at("16:20"), at("16:40"))),
    "buffers 0: the confirm's live window for 16:20 does not reach the 16:00 call",
  );
}

// 2. As stored now (10 and 10): nothing closer than ten minutes is offered, judged
//    or confirmed, and the nearest times on each side keep exactly the ten.
{
  const row = eventTypeRow(10);
  const offered = computeBucketSlots({ ...inputsFor(row), members: [advisor], from, to });
  for (const refused of ["15:40", "15:50", "16:00", "16:10", "16:20"]) {
    assert(!offered.includes(at(refused)), `buffers 10: ${refused} is not offered`);
  }
  assert(offered.includes(at("15:30")) && offered.includes(at("16:30")), "buffers 10: 15:30 and 16:30 are offered");
  const closest = Math.min(...offered.map((s) => gapMin(s, row.duration_min)));
  assert(closest === 10, `buffers 10: the closest offered call keeps exactly 10 minutes (got ${closest})`);
  assert(
    !freeMembersForSlot([advisor], inputsFor(row), Date.parse(at("16:20"))).includes("advisor"),
    "buffers 10: the candidate judge refuses the advisor at 16:20",
  );
  assert(
    overlaps(bufferedWindow(row, at("16:20"), at("16:40"))),
    "buffers 10: the confirm's live window for 16:20 reaches the 16:00 call, so verify refuses it",
  );
  assert(
    !overlaps(bufferedWindow(row, at("16:30"), at("16:50"))),
    "buffers 10: the confirm's live window for 16:30 stops at the 16:00 call's end",
  );
}

finish();
