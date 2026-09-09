// The mapping behind `pnpm import:calcom-schedules` (#1738, #1739). Run:
//   node --experimental-strip-types scripts/test-calcom-schedule-import.ts
//
// Slate holds one seeded window for the whole roster (Mon to Fri, 08:00 to 17:00,
// America/New_York for all 117). cal.com holds what the agents have actually been
// maintaining: measured 2026-09-02, 81 of 100 have different hours and 74 of 103
// are not Eastern. This is the mapping that moves the real thing into Slate.
//
// THE ZONE AND THE HOURS TRAVEL TOGETHER, and the tests below pin that. Importing
// hours WITHOUT the zone is worse than doing nothing: it moves an agent's window to
// their real local hours while Slate still reads it as Eastern, which shifts the
// error instead of removing it. A Phoenix agent would go from wrong to differently
// wrong, and nothing would report either.
//
// Every unreadable input is REFUSED rather than defaulted. Defaulting to Eastern is
// precisely how the roster came to claim one timezone it does not have, so a
// mapping that silently fell back would recreate the defect it exists to fix.
import { mapCalcomSchedule, diffSchedule, retryDelayMs, skipKindForStatus, paceMs } from "./lib/calcom-schedule-import.ts";
import { planScheduleReplacement } from "@/lib/schedule-replacement";
import { assert, eq, finish } from "./lib/harness.ts";

const uniform = {
  timeZone: "America/Phoenix",
  availability: [
    { days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], startTime: "08:00", endTime: "17:00" },
  ],
};

// --- mapping cal.com's shape onto Slate's rules -------------------------------
{
  const m = mapCalcomSchedule(uniform);
  assert(m.ok, "a well-formed schedule maps");
  if (m.ok) {
    eq(m.timezone, "America/Phoenix", "the timezone comes across, never assumed");
    eq(m.rules.length, 5, "one rule per named day");
    eq(m.rules[0], { weekday: 1, start_minute: 480, end_minute: 1020 }, "Monday is Luxon weekday 1, minutes from local midnight");
    eq(m.rules[4].weekday, 5, "Friday is 5");
  }
}
{
  // Luxon puts Sunday at 7, not 0. Getting this wrong shifts an agent's whole week
  // by a day and every slot with it.
  const m = mapCalcomSchedule({ timeZone: "America/New_York", availability: [{ days: ["Sunday", "Saturday"], startTime: "10:00", endTime: "14:00" }] });
  assert(m.ok, "a weekend schedule maps");
  if (m.ok) eq(m.rules.map((r) => r.weekday).sort(), [6, 7], "Saturday is 6 and Sunday is 7");
}
{
  // 17 of 103 agents really do have different hours on different days, so several
  // entries must produce several rules rather than being collapsed to the first.
  const m = mapCalcomSchedule({
    timeZone: "America/Denver",
    availability: [
      { days: ["Monday", "Tuesday"], startTime: "07:00", endTime: "16:00" },
      { days: ["Wednesday"], startTime: "09:30", endTime: "18:30" },
    ],
  });
  assert(m.ok, "a varying week maps");
  if (m.ok) {
    eq(m.rules.length, 3, "every entry contributes its own days");
    eq(m.rules.find((r) => r.weekday === 3), { weekday: 3, start_minute: 570, end_minute: 1110 }, "Wednesday keeps its own window");
  }
}
{
  const m = mapCalcomSchedule({ timeZone: "America/New_York", availability: [{ days: ["Monday"], startTime: "08:15", endTime: "16:45" }] });
  assert(m.ok, "quarter-hour boundaries map");
  if (m.ok) eq(m.rules[0], { weekday: 1, start_minute: 495, end_minute: 1005 }, "to exact minutes, never rounded");
}

// --- every unreadable input is refused, never defaulted ------------------------
{
  const m = mapCalcomSchedule({ timeZone: "", availability: uniform.availability });
  assert(!m.ok, "an empty timezone is refused rather than falling back to Eastern");
}
{
  const m = mapCalcomSchedule({ availability: uniform.availability });
  assert(!m.ok, "a missing timezone is refused for the same reason");
}
{
  const m = mapCalcomSchedule({ timeZone: "Mars/Olympus", availability: uniform.availability });
  assert(!m.ok, "a timezone no clock recognises is refused, never written");
}
{
  const m = mapCalcomSchedule({ timeZone: "America/New_York", availability: [] });
  assert(!m.ok, "an empty availability list is refused: it is not a five-day week");
}
{
  const m = mapCalcomSchedule({ timeZone: "America/New_York" });
  assert(!m.ok, "a missing availability list is refused");
}
{
  const m = mapCalcomSchedule({ timeZone: "America/New_York", availability: [{ days: ["Frunsday"], startTime: "08:00", endTime: "17:00" }] });
  assert(!m.ok, "an unrecognised day name is refused, never dropped");
}
{
  // Dropping the bad entry would produce a SHORTER week that still looks like a
  // real answer, and the agent would simply stop being offered on that day.
  const m = mapCalcomSchedule({ timeZone: "America/New_York", availability: [{ days: ["Monday", "Frunsday"], startTime: "08:00", endTime: "17:00" }] });
  assert(!m.ok, "one bad day poisons the whole schedule rather than shortening it");
}
{
  const m = mapCalcomSchedule({ timeZone: "America/New_York", availability: [{ days: ["Monday"], startTime: "8am", endTime: "17:00" }] });
  assert(!m.ok, "an unparseable time is refused");
}
{
  const m = mapCalcomSchedule({ timeZone: "America/New_York", availability: [{ days: ["Monday"], startTime: "25:00", endTime: "26:00" }] });
  assert(!m.ok, "an out-of-range time is refused");
}
{
  // Slate's rules are minutes from local midnight within ONE day, so a window that
  // ends before it starts cannot be represented and must not be written as if it
  // could: it would be a zero-length or negative day nobody would notice.
  const m = mapCalcomSchedule({ timeZone: "America/New_York", availability: [{ days: ["Monday"], startTime: "22:00", endTime: "06:00" }] });
  assert(!m.ok, "an overnight window is refused rather than written backwards");
}
{
  const m = mapCalcomSchedule({ timeZone: "America/New_York", availability: [{ days: ["Monday"], startTime: "09:00", endTime: "09:00" }] });
  assert(!m.ok, "a zero-length window is refused");
}

// --- the diff, which is what a person reads before approving anything ----------
const current = {
  timezone: "America/New_York",
  rules: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start_minute: 480, end_minute: 1020 })),
};
{
  const d = diffSchedule(current, { timezone: "America/New_York", rules: current.rules });
  assert(!d.changed, "an agent already matching cal.com is not changed");
  eq(d.reasons.length, 0, "and has nothing to report");
}
{
  // The roster's commonest real case: same hours on the clock, different zone. It
  // MUST register as a change, because the stored numbers are identical and only
  // the zone makes them mean different instants.
  const d = diffSchedule(current, { timezone: "America/Phoenix", rules: current.rules });
  assert(d.changed, "the same numbers in a different zone is a change");
  assert(d.reasons.some((r) => r.includes("timezone")), "and the reason names the timezone");
}
{
  const d = diffSchedule(current, {
    timezone: "America/New_York",
    rules: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start_minute: 540, end_minute: 1080 })),
  });
  assert(d.changed, "different hours in the same zone is a change");
  assert(d.reasons.some((r) => r.includes("hours")), "named as hours");
}
{
  const d = diffSchedule(current, {
    timezone: "America/New_York",
    rules: [...current.rules, { weekday: 6, start_minute: 480, end_minute: 1020 }],
  });
  assert(d.changed, "an added working day is a change");
  assert(d.reasons.some((r) => r.includes("days")), "named as days");
}
{
  // Order must not decide the answer: the same week arriving sorted differently is
  // the same week, and a positional comparison would report a false change on it.
  const shuffled = [...current.rules].reverse();
  const d = diffSchedule(current, { timezone: "America/New_York", rules: shuffled });
  assert(!d.changed, "rule order does not make a difference a change");
}

// --- rate limiting, which the first real run met at agent 15 -------------------
// cal.com answered 429 for 89 of 103 agents. The run was right to report them
// rather than guess, but a 429 is TRANSIENT and a split shift is not, and putting
// both under one heading tells a reader to go and fix 89 people by hand.
{
  eq(retryDelayMs(200, null, 0), null, "a success is never retried");
  eq(retryDelayMs(404, null, 0), null, "a not-found is never retried: trying again cannot create the schedule");
  eq(retryDelayMs(403, null, 0), null, "a refusal is never retried");
}
{
  assert((retryDelayMs(429, null, 0) ?? 0) > 0, "a rate limit is retried");
  assert((retryDelayMs(500, null, 0) ?? 0) > 0, "a server error is retried");
  assert((retryDelayMs(503, null, 0) ?? 0) > 0, "so is an unavailable");
}
{
  const first = retryDelayMs(429, null, 0) ?? 0;
  const later = retryDelayMs(429, null, 3) ?? 0;
  assert(later > first, "the wait grows with each attempt rather than hammering a system already refusing us");
}
{
  // The server's own instruction beats our guess: it knows when it will accept us.
  eq(retryDelayMs(429, "2", 0), 2000, "a Retry-After in seconds is honoured");
  eq(retryDelayMs(429, "0", 0), 0, "including an immediate one");
}
{
  // A Retry-After we cannot read must fall back to the backoff, never to NaN: a
  // NaN delay is passed to a timer that treats it as zero, so the retry storms.
  const d = retryDelayMs(429, "in a little while", 1);
  assert(typeof d === "number" && Number.isFinite(d) && d > 0, "an unreadable Retry-After falls back to the backoff");
}
{
  eq(retryDelayMs(429, null, 99), null, "retries are bounded: eventually it gives up rather than looping forever");
}

// --- transient and permanent skips are different things ------------------------
// Decided from the STATUS and carried on the record, never re-derived from the
// message. A classifier reading its own prose is one reworded sentence away from
// silently reclassifying a whole population.
{
  eq(skipKindForStatus(429), "transient", "a rate limit is transient");
  eq(skipKindForStatus(500), "transient", "so is a server fault");
  eq(skipKindForStatus(503), "transient", "and an unavailable");
  eq(skipKindForStatus(404), "permanent", "a missing schedule needs a person, not another attempt");
  eq(skipKindForStatus(403), "permanent", "so does a refusal");
  eq(skipKindForStatus(400), "permanent", "so does a bad request");
}

// --- the pace between agents ---------------------------------------------------
// It is read from the environment and handed straight to a timer. An unreadable
// value becoming NaN would fire immediately, dropping the pacing that exists to
// keep the run under the rate limit, and the run would fail the way the first one
// did while the setting still read as configured.
{
  eq(paceMs(undefined), 250, "an unset pace uses the default");
  eq(paceMs(""), 250, "so does an empty one");
  eq(paceMs("abc"), 250, "and one that is not a number, rather than becoming NaN");
  eq(paceMs("-5"), 250, "a negative pace is not a pace");
  eq(paceMs("500"), 500, "a real value is honoured");
  eq(paceMs("0"), 0, "and zero is a deliberate choice, not a missing one");
}

// --- split shifts: import the days we CAN represent ---------------------------
// Slate stores one window per weekday, so an agent with two shifts on a Tuesday
// cannot be represented. Merging them into 08:00 to 18:00 would make that agent
// bookable straight through a break they never offered, so the split DAY is left
// out and every other day is imported. Dan's call, 2026-09-02.
//
// Leaving a day out is not free: the agent is offered nothing that day. So the
// dropped days are returned rather than swallowed, and the caller has to say so.
// --- split shifts, which used to be dropped and are now imported (#1782) -------
// These blocks replace the `dropSplitDays` tests. That helper left out any weekday
// carrying two windows, which was right while Slate could hold only one per day: it
// kept jkite@, jsullivan@ and pdelacerda@ out of the import, and each was given a
// single full-day span by hand instead, which makes them bookable straight through
// a break they never offered. The hours editor rebuild removed the limit, so the
// shifts now travel all the way into a valid plan, and what is asserted here is the
// end of that road rather than the helper that used to block it.
{
  const m = mapCalcomSchedule({
    timeZone: "America/Los_Angeles",
    availability: [
      { days: ["Monday", "Tuesday"], startTime: "08:00", endTime: "12:00" },
      { days: ["Monday", "Tuesday"], startTime: "13:00", endTime: "17:00" },
    ],
  });
  assert(m.ok, "a split week maps");
  if (m.ok) {
    eq(m.rules.length, 4, "both shifts on both days survive, rather than the day being dropped");
    const plan = planScheduleReplacement(m.rules, m.timezone);
    assert(plan.ok, "and Slate's own validator accepts it");
    if (plan.ok) {
      eq(plan.rules.length, 4, "the plan carries every window");
      eq(
        plan.rules.map((r) => `${r.weekday}:${r.start_minute}`),
        ["1:480", "1:780", "2:480", "2:780"],
        "sorted by day and then by start, so the morning is never rendered below the afternoon",
      );
    }
  }
}
{
  // Windows that TOUCH are a legitimate way to write one span and must not be
  // mistaken for an overlap: refusing them would strand an agent whose cal.com week
  // happens to be entered as two halves.
  const m = mapCalcomSchedule({
    timeZone: "America/New_York",
    availability: [
      { days: ["Wednesday"], startTime: "08:00", endTime: "12:00" },
      { days: ["Wednesday"], startTime: "12:00", endTime: "17:00" },
    ],
  });
  assert(m.ok, "touching windows map");
  if (m.ok) assert(planScheduleReplacement(m.rules, m.timezone).ok, "and are accepted");
}
{
  // The one week that genuinely cannot be represented now, and the reason the
  // import still needs a refusal path at all. It is refused by Slate's validator
  // rather than by anything here, so there is one rule about what a week may be.
  const m = mapCalcomSchedule({
    timeZone: "America/New_York",
    availability: [
      { days: ["Thursday"], startTime: "08:00", endTime: "13:00" },
      { days: ["Thursday"], startTime: "12:00", endTime: "17:00" },
    ],
  });
  assert(m.ok, "an overlapping week still maps, because mapping is not validation");
  if (m.ok) {
    const plan = planScheduleReplacement(m.rules, m.timezone);
    assert(!plan.ok, "and Slate refuses it rather than writing hours nobody meant");
    if (!plan.ok) {
      assert(
        plan.error.includes("Thursday"),
        `the refusal names the day, so the importer can name the agent AND the day (${plan.error})`,
      );
    }
  }
}

finish();
