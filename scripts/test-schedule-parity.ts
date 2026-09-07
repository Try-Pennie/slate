// The comparison behind `pnpm verify:schedule-parity` (#1754). Run:
//   node --experimental-strip-types scripts/test-schedule-parity.ts
//
// WHY THIS REPLACED A SLOT COMPARISON. The first parity probe (#1731) narrowed
// cal.com's answer to one bucket's agents with `routedTeamMemberIds[]` on
// `GET /v2/slots`. That parameter does not exist on that endpoint: every spelling
// answers 400, and zero pins answers 200 with the whole pool. Re-measured live on
// 2026-09-07, still 400. So the comparison it was built on could never execute,
// and the probe was merged, documented and unusable.
//
// Schedules are compared instead, through the same endpoint the OOO dual-write
// already uses. It is strictly better for the question being asked: per agent, so
// one misconfigured person cannot be masked by a healthy pool; no dependency on
// busy time being hydrated; and it targets what was actually wrong, which was
// hours and timezone drift (81 of 100 and 74 of 103 on 2026-09-02).
//
// THE COMPARISON IS EXACT, and that is a deliberate departure from #1754's body,
// which asked for the (day, hour) bucketing the slot probe used. That bucketing
// existed because the two systems carry different slot intervals, durations and
// buffers, so demanding equal instants would have been red from the day it
// shipped. None of that applies here: both sides store a weekday plus start and
// end minutes, so the values are directly comparable, and bucketing to the hour
// would HIDE drift rather than tolerate noise. An agent moving 09:00 to 09:30
// still opens hour 9, and 26 of the roster's real windows sit on a half or quarter
// hour, so hour bucketing would report the commonest kind of drift as agreement.
import {
  compareAgentSchedule,
  worstVerdict,
  describeWindows,
  zonesAgree,
  VERDICT_RANK,
  type CalcomSide,
} from "./lib/schedule-parity.ts";
import type { SlateSchedule } from "./lib/calcom-schedule-import.ts";
import { assert, eq, finish } from "./lib/harness.ts";

/** Mon to Fri 08:00 to 17:00 Eastern: the seeded week the whole roster carried
 *  before the 2026-09-02 import, and still the default a new schedule gets. */
const seeded: SlateSchedule = {
  timezone: "America/New_York",
  rules: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start_minute: 480, end_minute: 1020 })),
};

/** cal.com's real payload shape, taken from a live read of an actual agent. */
function calcom(timeZone: string, availability: unknown[]): CalcomSide {
  return { kind: "schedule", schedule: { timeZone, availability } };
}

const weekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

// --- the agreeing case, which every other assertion is measured against --------
{
  // A real agent read live on 2026-09-07: geoff@, Mon to Fri 09:00 to 18:00,
  // America/New_York. Slate holding the same thing must read as agreement, or
  // every finding below is just the comparison being noisy.
  const slate: SlateSchedule = {
    timezone: "America/New_York",
    rules: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start_minute: 540, end_minute: 1080 })),
  };
  const r = compareAgentSchedule(
    "geoff@trypennie.com",
    slate,
    calcom("America/New_York", [{ days: weekdays, startTime: "09:00", endTime: "18:00" }]),
  );
  eq(r.verdict, "agree", "identical timezone and windows agree");
  eq(r.reasons.length, 0, "an agreeing agent carries no reasons");
}

// --- two zone names that are one clock -----------------------------------------
// The first live sweep (2026-09-07) reported 10 agents as timezone-differs, and
// every one was a pair that keeps identical time: 9 of America/Denver against
// America/Boise, and one of America/New_York against America/Indiana/Indianapolis.
// Measured over 9,600 consecutive hours, those pairs differ on ZERO of them, while
// Denver against Phoenix differs on 5,711 and New York against Chicago on 9,599.
//
// Reporting a name that changes nothing as the run's headline is how a check
// teaches people to skip it (L36), and it did real damage on that first run: the
// one agent with a genuine Saturday-for-Friday swap was filed under a zone label
// because the label outranked it. So a difference in NAME that is not a difference
// in CLOCK gets its own verdict, ranked below every real finding.
{
  const nowMs = Date.parse("2026-09-07T00:00:00Z");
  eq(zonesAgree("America/Denver", "America/Boise", nowMs), true, "Denver and Boise are one clock");
  eq(
    zonesAgree("America/New_York", "America/Indiana/Indianapolis", nowMs),
    true,
    "New York and Indianapolis are one clock, Indiana having observed DST since 2006",
  );
  // The controls. Without these the function could return true for everything and
  // every zone finding in the product would silently vanish (L1).
  eq(
    zonesAgree("America/Denver", "America/Phoenix", nowMs),
    false,
    "Denver and Phoenix are NOT, because Arizona does not move its clocks",
  );
  eq(zonesAgree("America/New_York", "America/Chicago", nowMs), false, "and neither are two real offsets apart");
  eq(zonesAgree("America/New_York", "America/New_York", nowMs), true, "a zone agrees with itself");
  // A zone no clock can read cannot be claimed to agree with anything. Answering
  // true would silently downgrade a genuinely broken value to cosmetic.
  eq(zonesAgree("America/New_York", "Mars/Olympus", nowMs), false, "an unreadable zone never reads as agreement");
}
{
  const r = compareAgentSchedule(
    "agarcia@trypennie.com",
    { timezone: "America/Denver", rules: seeded.rules },
    calcom("America/Boise", [{ days: weekdays, startTime: "08:00", endTime: "17:00" }]),
  );
  eq(r.verdict, "timezone-name-differs", "a different name for the same clock is its own, lesser finding");
  assert(
    r.reasons.some((x) => x.includes("America/Boise") && x.includes("same clock")),
    "and the reason says outright that nothing a lead sees changes",
  );
}
{
  // dhaggerty@ on the first live sweep. The zone name is cosmetic and the day swap
  // is real: an agent offered on a Saturday they do not work and withheld on a
  // Friday they do. The real finding must be the one that names them.
  const r = compareAgentSchedule(
    "dhaggerty@trypennie.com",
    {
      timezone: "America/New_York",
      rules: [1, 2, 3, 4, 6].map((weekday) => ({ weekday, start_minute: 480, end_minute: 1020 })),
    },
    calcom("America/Indiana/Indianapolis", [{ days: weekdays, startTime: "08:00", endTime: "17:00" }]),
  );
  eq(r.verdict, "days-differ", "the real difference outranks the cosmetic one");
  assert(r.reasons.some((x) => x.includes("Friday")), "the day they work and are not offered is named");
  assert(r.reasons.some((x) => x.includes("same clock")), "and the zone name is still reported, just not as the headline");
}

// --- the severe half: same clock numbers, different zone (#1739) ---------------
{
  // The commonest real shape on this roster. The rules are byte-identical, so any
  // comparison that read only the numbers would report the largest population of
  // wrong agents as needing no change at all.
  const r = compareAgentSchedule(
    "someone@trypennie.com",
    seeded,
    calcom("America/Phoenix", [{ days: weekdays, startTime: "08:00", endTime: "17:00" }]),
  );
  eq(r.verdict, "timezone-differs", "identical numbers in a different zone is a finding, not agreement");
  assert(
    r.reasons.some((x) => x.includes("America/New_York") && x.includes("America/Phoenix")),
    "the reason names both zones so a reader can act without a second query",
  );
}
{
  // Timezone AND hours can both be wrong at once. The verdict names the most
  // severe, but nothing may be dropped: an agent fixed only for the zone would
  // otherwise read as done.
  const r = compareAgentSchedule(
    "both@trypennie.com",
    seeded,
    calcom("America/Los_Angeles", [{ days: weekdays, startTime: "10:00", endTime: "19:00" }]),
  );
  eq(r.verdict, "timezone-differs", "the worst difference names the agent");
  assert(r.reasons.length >= 2, "every difference is reported, not just the one that named the verdict");
  assert(r.reasons.some((x) => x.includes("10:00")), "the hours difference survives alongside the zone one");
}

// --- days ---------------------------------------------------------------------
{
  // Several agents work Saturdays and several do not work Mondays. A day Slate
  // does not hold is a day the agent works and is never offered on.
  const r = compareAgentSchedule(
    "sat@trypennie.com",
    seeded,
    calcom("America/New_York", [
      { days: [...weekdays, "Saturday"], startTime: "08:00", endTime: "17:00" },
    ]),
  );
  eq(r.verdict, "days-differ", "a day in one system and not the other is a days finding");
  assert(r.reasons.some((x) => x.includes("Saturday")), "the reason names the day, not a digit");
}

// --- hours, at the resolution the roster actually uses -------------------------
{
  // Quarter and half hour offsets are real on this roster (07:45 to 16:15, 08:30
  // to 17:30, 09:30 to 18:30). Hour bucketing would call every one of these
  // agreement, which is exactly why the comparison is exact.
  const r = compareAgentSchedule(
    "half@trypennie.com",
    seeded,
    calcom("America/New_York", [{ days: weekdays, startTime: "08:30", endTime: "17:30" }]),
  );
  eq(r.verdict, "hours-differ", "a thirty minute shift is a difference, not noise");
  assert(
    r.reasons.some((x) => x.includes("08:00") && x.includes("08:30")),
    "the reason shows both sides so the fix needs no second lookup",
  );
}
{
  // The same total span split differently across the week. Comparing a collapsed
  // earliest-start-to-latest-end would call this agreement.
  const slate: SlateSchedule = {
    timezone: "UTC",
    rules: [
      { weekday: 1, start_minute: 480, end_minute: 1020 },
      { weekday: 2, start_minute: 480, end_minute: 1020 },
    ],
  };
  const r = compareAgentSchedule(
    "varying@trypennie.com",
    slate,
    calcom("UTC", [
      { days: ["Monday"], startTime: "08:00", endTime: "17:00" },
      { days: ["Tuesday"], startTime: "10:00", endTime: "19:00" },
    ]),
  );
  eq(r.verdict, "hours-differ", "a per-day difference is not hidden by a matching week total");
  assert(r.reasons.some((x) => x.includes("Tuesday")), "the differing day is named");
  assert(!r.reasons.some((x) => x.includes("Monday")), "the matching day is not reported as a difference");
}

// --- split shifts, which Slate can now hold (#1782) ----------------------------
{
  // Three agents work two shifts a day with a gap. Until #1782 Slate held one
  // window per weekday and the importer dropped these days; it can hold both now,
  // so a split week that matches must read as agreement rather than as a finding.
  const slate: SlateSchedule = {
    timezone: "America/Los_Angeles",
    rules: [
      { weekday: 1, start_minute: 480, end_minute: 720 },
      { weekday: 1, start_minute: 780, end_minute: 1020 },
    ],
  };
  const r = compareAgentSchedule(
    "jkite@trypennie.com",
    slate,
    calcom("America/Los_Angeles", [
      { days: ["Monday"], startTime: "08:00", endTime: "12:00" },
      { days: ["Monday"], startTime: "13:00", endTime: "17:00" },
    ]),
  );
  eq(r.verdict, "agree", "two matching windows on one day agree");
}
{
  // The state those three agents are in TODAY: Slate holds the full span, cal.com
  // holds two shifts. The agent is bookable straight through their break, and this
  // is the comparison that has to say so.
  const slate: SlateSchedule = {
    timezone: "America/Los_Angeles",
    rules: [{ weekday: 1, start_minute: 480, end_minute: 1020 }],
  };
  const r = compareAgentSchedule(
    "jkite@trypennie.com",
    slate,
    calcom("America/Los_Angeles", [
      { days: ["Monday"], startTime: "08:00", endTime: "12:00" },
      { days: ["Monday"], startTime: "13:00", endTime: "17:00" },
    ]),
  );
  eq(r.verdict, "hours-differ", "one span against two shifts is a difference");
  assert(
    r.reasons.some((x) => x.includes("12:00") && x.includes("13:00")),
    "the reason shows the break the agent is bookable through",
  );
}

// --- the states where nothing can be compared, each said separately ------------
// Every one of these is a different instruction to a different person, and folding
// any two together makes one answer for the other (L11).
{
  const r = compareAgentSchedule("newhire@trypennie.com", seeded, { kind: "user-missing" });
  eq(r.verdict, "no-calcom-user", "an agent with no cal.com account is its own outcome");
}
{
  // mharris@ today: in cal.com, with no schedule at all.
  const r = compareAgentSchedule("mharris@trypennie.com", seeded, { kind: "schedule-missing" });
  eq(r.verdict, "no-calcom-schedule", "a cal.com user with no schedule is not the same as no user");
}
{
  // cfrank@ today: a schedule exists and holds no windows. Distinct again, because
  // the remedy is to ask the agent rather than to check their cal.com account.
  const r = compareAgentSchedule("cfrank@trypennie.com", seeded, calcom("America/Boise", []));
  eq(r.verdict, "no-calcom-schedule", "a schedule carrying no windows cannot be compared");
  assert(r.reasons.some((x) => x.length > 0), "and it says why rather than reporting a bare kind");
}
{
  // The read failed rather than answered. Distinct from an unreadable payload:
  // this one clears by running the sweep again, that one needs somebody to look at
  // what cal.com is now returning. One message answering for the other is how a
  // person spends an afternoon on a rate limit (L11).
  const t = compareAgentSchedule("busy@trypennie.com", seeded, {
    kind: "read-failed",
    status: 429,
    transient: true,
  });
  eq(t.verdict, "calcom-unreachable", "a failed read is not an unreadable payload");
  assert(t.reasons.some((x) => x.includes("429")), "the reason carries the status rather than a shrug");
  assert(t.reasons.some((x) => x.includes("run it again")), "and a transient one says the run can be repeated");

  const p = compareAgentSchedule("gone@trypennie.com", seeded, {
    kind: "read-failed",
    status: 404,
    transient: false,
  });
  eq(p.verdict, "calcom-unreachable", "a permanent refusal is the same verdict");
  assert(
    p.reasons.some((x) => x.includes("cannot fix")),
    "but says another attempt will not help, so nobody re-runs a sweep for it",
  );
}
{
  // A bookable agent with no hours in Slate. They are offered nothing, which looks
  // from every Slate surface exactly like a quiet agent.
  const r = compareAgentSchedule(
    "nohours@trypennie.com",
    { timezone: "America/New_York", rules: [] },
    calcom("America/New_York", [{ days: weekdays, startTime: "09:00", endTime: "18:00" }]),
  );
  eq(r.verdict, "no-slate-schedule", "a bookable agent with no rules in Slate is a finding of its own");
}
{
  const r = compareAgentSchedule("nada@trypennie.com", null, { kind: "user-missing" });
  eq(r.verdict, "no-slate-schedule", "missing on both sides is reported by the side we own");
}

// --- an unreadable cal.com answer is refused, never salvaged -------------------
{
  // A payload we half-understand yields a SMALLER week, which is indistinguishable
  // from an agent genuinely working less, and would be reported as a real hours
  // finding: a defect in our own parsing wearing the costume of a defect in the
  // roster (L340).
  const r = compareAgentSchedule(
    "broken@trypennie.com",
    seeded,
    calcom("America/New_York", [{ days: ["Moonday"], startTime: "08:00", endTime: "17:00" }]),
  );
  eq(r.verdict, "calcom-unreadable", "an unrecognised day refuses the whole schedule");
  assert(r.reasons.some((x) => x.includes("Moonday")), "and names what it could not read");
}
{
  const r = compareAgentSchedule(
    "nozone@trypennie.com",
    seeded,
    calcom("", [{ days: weekdays, startTime: "08:00", endTime: "17:00" }]),
  );
  eq(r.verdict, "calcom-unreadable", "a schedule with no timezone is refused, never defaulted to Eastern");
}

// --- the run's own verdict -----------------------------------------------------
{
  // A sweep is only as good as its worst agent: one wrong timezone among a hundred
  // agreements is the finding.
  eq(
    worstVerdict(["agree", "agree", "hours-differ", "agree"]),
    "hours-differ",
    "one difference among agreements names the run",
  );
  eq(
    worstVerdict(["hours-differ", "timezone-differs", "days-differ"]),
    "timezone-differs",
    "the zone difference outranks the others, being the one that moves every window",
  );
  eq(
    worstVerdict(["timezone-name-differs", "hours-differ"]),
    "hours-differ",
    "a cosmetic zone name never outranks a real difference, which is the whole point of splitting it out",
  );
  eq(
    worstVerdict(["agree", "timezone-name-differs"]),
    "timezone-name-differs",
    "but it is still reported, so a drifted name is never silently passed",
  );
  eq(worstVerdict(["agree", "agree"]), "agree", "all agreeing is agreement");
  eq(worstVerdict([]), null, "nothing compared is not agreement (L98)");
  eq(
    worstVerdict(["no-calcom-user", "no-calcom-schedule"]),
    "no-calcom-schedule",
    "an unusable comparison still ranks, so a sweep of them never exits zero",
  );
}
{
  // Every verdict the module can produce must have a rank, or the run's exit code
  // silently falls through to agreement for whichever one was forgotten.
  const produced: string[] = [
    "agree",
    "timezone-differs",
    "days-differ",
    "hours-differ",
    "no-slate-schedule",
    "no-calcom-schedule",
    "no-calcom-user",
    "timezone-name-differs",
    "calcom-unreachable",
    "calcom-unreadable",
  ];
  for (const v of produced) {
    assert(v in VERDICT_RANK, `${v} carries a rank, so it can never be scored as agreement by omission`);
  }
  eq(Object.keys(VERDICT_RANK).length, produced.length, "and no rank exists for a verdict nothing produces");
}

// --- the rendering a person actually reads -------------------------------------
{
  eq(
    describeWindows([{ weekday: 1, start_minute: 480, end_minute: 1020 }]),
    "08:00 to 17:00",
    "minutes from midnight are shown as a clock, because nobody reads 480",
  );
  eq(
    describeWindows([
      { weekday: 1, start_minute: 480, end_minute: 720 },
      { weekday: 1, start_minute: 780, end_minute: 1020 },
    ]),
    "08:00 to 12:00, 13:00 to 17:00",
    "a split day shows both shifts and the gap between them",
  );
  eq(describeWindows([]), "nothing", "a day with no windows says so in words");
}

finish();
