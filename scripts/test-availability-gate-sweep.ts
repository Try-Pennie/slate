// #1300: the three availability gates hold on every path that OFFERS or ACCEPTS a
// time, not only on the read the booker uses to draw a calendar.
//
// The read path is the one everybody thinks about, and it is the one path a lead
// cannot use to book an out of hours time anyway, because they are only shown what
// it produced. The paths that matter are the ones that ACCEPT a time somebody else
// chose: a bot calling the booking API with an instant of its own, a reschedule, and
// a slot that was computed under a wider window and is still sitting in the cache.
//
// The defect this sweep found is in the monitoring rather than the gate. The gate
// itself refuses an out of hours booking correctly, but the way it refused could not
// tell two opposite things apart, and it paged about the wrong one. See below.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-availability-gate-sweep.ts
import { DateTime } from "luxon";
import {
  bookableSlotReason,
  slotsWithinBusinessHours,
  type BusinessHoursRules,
  type MemberAvailability,
  type SlotRules,
} from "../src/lib/availability/compute.ts";
import {
  NoEligibleAgentsError,
  SlotUnavailableError,
  createBooking,
} from "../src/lib/booking/orchestration.ts";
import { bookingFailureAlert } from "../src/lib/booking/service.ts";
import { makeDeps, input } from "./lib/booking-fakes.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ZONE = "America/New_York";
const at = (iso: string) => DateTime.fromISO(iso, { zone: ZONE }).toMillis();
const weekdayOf = (iso: string) => DateTime.fromISO(iso, { zone: ZONE }).weekday;

/** Monday to Friday, 09:00 to 17:00, in the org's zone. Closed at weekends. */
function weekdayHours(): BusinessHoursRules {
  return {
    zone: ZONE,
    rules: [1, 2, 3, 4, 5].map((weekday) => ({
      weekday,
      start_minute: 9 * 60,
      end_minute: 17 * 60,
    })), exceptions: [] };
}

function rules(businessHours: BusinessHoursRules, durationMin = 30): SlotRules {
  return {
    durationMin,
    bufferBeforeMin: 0,
    bufferAfterMin: 0,
    minNoticeMin: 0,
    dailyCap: null,
    businessHours,
  };
}

/** An agent rostered far wider than the org is open, which is the realistic case. */
function alwaysOnAgent(): Pick<
  MemberAvailability,
  "timezone" | "rules" | "busy" | "bookingStartsMs"
> {
  return {
    timezone: ZONE,
    rules: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
      weekday,
      start_minute: 0,
      end_minute: 23 * 60 + 59,
    })),
    busy: [],
    bookingStartsMs: [],
  };
}

const LONG_AGO = at("2026-01-01T00:00");

// =====================================================================
// 1. An agent rostered WIDER than the org is open
// =====================================================================
// The most common real configuration, and the one where the org gate is the only
// thing standing between a caller and an out of hours booking. Every live agent is
// rostered 08:00 to 20:00 while the org's window is narrower, so this is not a
// hypothetical shape.
{
  const org = weekdayHours();
  const r = rules(org);
  const agent = alwaysOnAgent();
  const MON = "2026-08-10";
  eq(weekdayOf(MON), 1, "the fixture's Monday really is a Monday");

  eq(bookableSlotReason(agent, r, at(`${MON}T08:00`), LONG_AGO), "business_hours",
    "an hour before the org opens is refused even though the agent is on shift");
  eq(bookableSlotReason(agent, r, at(`${MON}T09:00`), LONG_AGO), null,
    "the org's opening minute is bookable");
  eq(bookableSlotReason(agent, r, at(`${MON}T16:30`), LONG_AGO), null,
    "a slot ending exactly at closing time fits");
  eq(bookableSlotReason(agent, r, at(`${MON}T16:45`), LONG_AGO), "business_hours",
    "a slot that would overrun closing time is refused, not just one starting after it");
  eq(bookableSlotReason(agent, r, at(`${MON}T19:00`), LONG_AGO), "business_hours",
    "an evening the agent is rostered for is still refused while the org is shut");
}

// =====================================================================
// 2. The midnight and Saturday boundaries
// =====================================================================
{
  const org = weekdayHours();
  const r = rules(org);
  const agent = alwaysOnAgent();

  // Saturday: the org has NO rule for weekday 6, which is what closed looks like.
  const SAT = "2026-08-15";
  eq(weekdayOf(SAT), 6, "the fixture's Saturday really is a Saturday");
  for (const hhmm of ["09:00", "12:00", "16:30"]) {
    eq(bookableSlotReason(agent, r, at(`${SAT}T${hhmm}`), LONG_AGO), "business_hours",
      `${hhmm} on Saturday is refused: a weekday-only org has no Saturday window at all`);
  }

  // Midnight either side of a closed day. Friday's last minutes are open; the
  // instant the clock passes into Saturday the org is shut, and the instant it
  // passes into Monday it is not yet open (09:00, not 00:00).
  const FRI = "2026-08-14";
  eq(bookableSlotReason(agent, r, at(`${FRI}T16:30`), LONG_AGO), null, "Friday afternoon is open");
  eq(bookableSlotReason(agent, r, at(`${FRI}T23:45`), LONG_AGO), "business_hours",
    "late Friday night is shut, because the window ends at 17:00 and not at midnight");
  const MON = "2026-08-17";
  eq(weekdayOf(MON), 1, "the following Monday really is a Monday");
  eq(bookableSlotReason(agent, r, at(`${MON}T00:00`), LONG_AGO), "business_hours",
    "midnight on Monday is shut: a new day is not an open day");
  eq(bookableSlotReason(agent, r, at(`${MON}T09:00`), LONG_AGO), null,
    "and 09:00 Monday opens it again, so the weekend refusal really does end");
}

// =====================================================================
// 3. A slot computed under the OLD, wider window
// =====================================================================
// The cache holds instants computed before someone narrowed the day. #1296 filters
// them at read time so an edit lands on the next request rather than the next
// recompute, and this is that filter judged by the same predicate the gate uses.
{
  const MON = "2026-08-10";
  const wide: BusinessHoursRules = {
    zone: ZONE,
    rules: [{ weekday: weekdayOf(MON), start_minute: 8 * 60, end_minute: 20 * 60 }], exceptions: [] };
  const narrowed: BusinessHoursRules = {
    zone: ZONE,
    rules: [{ weekday: weekdayOf(MON), start_minute: 9 * 60, end_minute: 17 * 60 }], exceptions: [] };
  const agent = alwaysOnAgent();

  // What the old window produced, as ISO instants, exactly as the cache stores them.
  const computedUnderWide = ["08:00", "08:30", "12:00", "16:30", "17:30", "19:00"].filter(
    (hhmm) => bookableSlotReason(agent, rules(wide), at(`${MON}T${hhmm}`), LONG_AGO) === null,
  );
  eq(computedUnderWide.length, 6, "the wider window really did offer all six times");

  const served = slotsWithinBusinessHours(
    computedUnderWide.map((hhmm) => new Date(at(`${MON}T${hhmm}`)).toISOString()),
    30,
    narrowed,
  );
  // Two, not three: 08:30 would END at 09:00, and a slot has to START inside the
  // window as well as finish inside it. Getting this count wrong by hand is exactly
  // why the surviving times are asserted by name below rather than by a total.
  eq(served.length, 2, "after the narrowing only the times inside the new window are served");
  const asLocal = served.map((iso) => DateTime.fromISO(iso, { zone: ZONE }).toFormat("HH:mm"));
  assert(!asLocal.includes("08:00") && !asLocal.includes("08:30"),
    "the early times the old window allowed are no longer served");
  assert(!asLocal.includes("17:30") && !asLocal.includes("19:00"),
    "and neither are the late ones");
  assert(asLocal.includes("12:00") && asLocal.includes("16:30"),
    "while the times inside both windows survive");

  // The read filter and the compute gate must agree exactly, or a slot could be
  // served that a book would then refuse, which is a lead choosing a time that
  // fails at confirm.
  for (const iso of computedUnderWide.map((h) => new Date(at(`${MON}T${h}`)).toISOString())) {
    const ms = DateTime.fromISO(iso).toMillis();
    const gate = bookableSlotReason(agent, rules(narrowed), ms, LONG_AGO) === null;
    eq(served.includes(iso), gate,
      `the read filter and the compute gate agree about ${DateTime.fromMillis(ms, { zone: ZONE }).toFormat("HH:mm")}`);
  }
}

// =====================================================================
// 4. An unreadable cached instant is dropped, never served
// =====================================================================
{
  const org = weekdayHours();
  const good = new Date(at("2026-08-10T12:00")).toISOString();
  const served = slotsWithinBusinessHours([good, "not-a-timestamp", ""], 30, org);
  eq(served, [good], "an instant that cannot be read is dropped rather than offered");
}

// =====================================================================
// 5. An out of hours booking request: refused, and refused for the RIGHT reason
// =====================================================================
// The path a lead cannot take but a bot can: a booking request naming an instant
// nobody offered. The gate refuses it correctly, and always did. What it could not
// do was say WHY, and the difference decides whether somebody's phone rings.
//
// The candidate list is filtered by all three gates, so an empty list has two
// causes: the bucket has nobody in it (a misconfiguration that should page), or it
// has people and none of them is on shift right now (an ordinary evening, which must
// not). Both arrived as zero candidates, and the alert said "has NO eligible
// bookable agents to route to. Check the bucket's agent attributes, bookable flags,
// and schedules" for both. That is the correct sentence for one of them and a false
// page blaming the wrong thing for the other, once per out of hours attempt.
{
  // Nobody in the bucket at all.
  {
    const { deps } = makeDeps({ candidates: [], memberCount: 0 });
    let caught: unknown;
    try {
      await createBooking(input, deps);
    } catch (e) {
      caught = e;
    }
    assert(caught instanceof NoEligibleAgentsError, "an EMPTY bucket still fails as a misconfiguration");
    const spec = bookingFailureAlert(caught);
    assert(!!spec, "#1300: and it still pages, which is the case the alert was written for");
    assert(
      (spec?.message ?? "").includes("NO eligible bookable agents"),
      "with the copy that tells the reader to check attributes, flags and schedules",
    );
  }

  // People exist; none of them can take this time. An evening, a weekend, or any
  // instant outside the org's window reaches exactly this branch.
  {
    const { deps } = makeDeps({ candidates: [], memberCount: 4 });
    let caught: unknown;
    try {
      await createBooking(input, deps);
    } catch (e) {
      caught = e;
    }
    assert(
      caught instanceof SlotUnavailableError,
      "#1300: a bucket with people but nobody free fails as an unavailable SLOT",
    );
    assert(
      !(caught instanceof NoEligibleAgentsError),
      "and never as a misconfigured bucket, which is somebody else's problem entirely",
    );
    eq(
      bookingFailureAlert(caught),
      null,
      "#1300: so nobody is paged for an ordinary out of hours attempt",
    );
  }

  // The two are told apart by the POOL SIZE, and nothing else can tell them apart:
  // the candidate list is identical in both cases above.
  {
    const empty = makeDeps({ candidates: [], memberCount: 0 });
    const offShift = makeDeps({ candidates: [], memberCount: 4 });
    const a = await empty.deps.roundRobinCandidates(
      { code: "411" } as never,
      { duration_min: 30 } as never,
      Date.now(),
    );
    const b = await offShift.deps.roundRobinCandidates(
      { code: "411" } as never,
      { duration_min: 30 } as never,
      Date.now(),
    );
    eq(a.candidates, b.candidates, "the free lists are identical in both cases");
    assert(a.memberCount !== b.memberCount, "and only the pool size distinguishes them");
  }
}

finish();
