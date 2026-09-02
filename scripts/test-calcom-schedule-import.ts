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
import { mapCalcomSchedule, diffSchedule, retryDelayMs, classifySkip } from "./lib/calcom-schedule-import.ts";
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
  const m = mapCalcomSchedule({ timeZone: "UTC", availability: [{ days: ["Sunday", "Saturday"], startTime: "10:00", endTime: "14:00" }] });
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
  const m = mapCalcomSchedule({ timeZone: "UTC", availability: [{ days: ["Monday"], startTime: "08:15", endTime: "16:45" }] });
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
  const m = mapCalcomSchedule({ timeZone: "UTC", availability: [] });
  assert(!m.ok, "an empty availability list is refused: it is not a five-day week");
}
{
  const m = mapCalcomSchedule({ timeZone: "UTC" });
  assert(!m.ok, "a missing availability list is refused");
}
{
  const m = mapCalcomSchedule({ timeZone: "UTC", availability: [{ days: ["Frunsday"], startTime: "08:00", endTime: "17:00" }] });
  assert(!m.ok, "an unrecognised day name is refused, never dropped");
}
{
  // Dropping the bad entry would produce a SHORTER week that still looks like a
  // real answer, and the agent would simply stop being offered on that day.
  const m = mapCalcomSchedule({ timeZone: "UTC", availability: [{ days: ["Monday", "Frunsday"], startTime: "08:00", endTime: "17:00" }] });
  assert(!m.ok, "one bad day poisons the whole schedule rather than shortening it");
}
{
  const m = mapCalcomSchedule({ timeZone: "UTC", availability: [{ days: ["Monday"], startTime: "8am", endTime: "17:00" }] });
  assert(!m.ok, "an unparseable time is refused");
}
{
  const m = mapCalcomSchedule({ timeZone: "UTC", availability: [{ days: ["Monday"], startTime: "25:00", endTime: "26:00" }] });
  assert(!m.ok, "an out-of-range time is refused");
}
{
  // Slate's rules are minutes from local midnight within ONE day, so a window that
  // ends before it starts cannot be represented and must not be written as if it
  // could: it would be a zero-length or negative day nobody would notice.
  const m = mapCalcomSchedule({ timeZone: "UTC", availability: [{ days: ["Monday"], startTime: "22:00", endTime: "06:00" }] });
  assert(!m.ok, "an overnight window is refused rather than written backwards");
}
{
  const m = mapCalcomSchedule({ timeZone: "UTC", availability: [{ days: ["Monday"], startTime: "09:00", endTime: "09:00" }] });
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
{
  eq(classifySkip("cal.com schedules returned 429"), "transient", "a rate limit is transient");
  eq(classifySkip("cal.com schedules returned 503"), "transient", "so is an unavailable");
  eq(classifySkip("cal.com read threw: fetch failed"), "transient", "so is a dropped connection");
  eq(classifySkip("Slate will not accept this week: same day twice"), "permanent", "a split shift needs a person");
  eq(classifySkip("no cal.com account, so there is nothing to import"), "permanent", "so does a missing account");
  eq(classifySkip("the schedule carries no availability windows"), "permanent", "so does an empty schedule");
}

finish();
