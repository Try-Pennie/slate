/**
 * #1936: the roster coverage alarm looks from today through the booking horizon
 * plus a staffing lead time, not at the calendar week it happens to be in.
 *
 * The old window was the Monday to Sunday week containing now, so the warning it
 * could give shrank to hours on a Saturday and to nothing on a Sunday, which is
 * exactly where the thin weekend coverage lives. Checked on a Saturday it could
 * see this Saturday's gap and never the next one.
 *
 * Every case below drives the REAL coverage predicate (`coverageForDate`, through
 * `coverageForRange`) and the real copy builders, with the clock injected. The
 * fixture week is the one production stores: 08:00 to 20:00 Monday to Saturday,
 * Sunday shut, Eastern, and a four day booking horizon.
 *
 * Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
 *        scripts/test-roster-coverage-horizon.ts
 */
import { DateTime } from "luxon";
import {
  ROSTER_COVERAGE_KEY,
  ROSTER_COVERAGE_UPCOMING_KEY,
  ROSTER_COVERAGE_QUIET_SEND_WEEKDAY,
  ROSTER_COVERAGE_UNJUDGED_WEEKDAY,
  STAFFING_LEAD_DAYS,
  coverageForRange,
  runRosterCoverageCheck,
  type RosterCoverageVerdict,
} from "../src/lib/monitor/roster-coverage.ts";
import type { BusinessHoursException } from "../src/lib/booking/business-hours.ts";
import { ALERT_CATALOG } from "../src/lib/notify/alert-catalog.ts";
import { ALERT_KEYS, codedCooldownMs } from "../src/lib/monitor/settings.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ZONE = "America/New_York";
const HORIZON_DAYS = 4;

/** Saturday 2026-09-26 at 10:00 Eastern: the day of the week the issue was filed about. */
const SATURDAY_10AM = DateTime.fromISO("2026-09-26T10:00", { zone: ZONE }).toMillis();

/** Mon to Sat, 08:00 to 20:00. Sunday has no rule, so it is shut. */
const RULES = [1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday,
  start_minute: 8 * 60,
  end_minute: 20 * 60,
}));

/** An exception opening one date at 07:00, an hour before anybody in the fixture starts. */
function earlyOpening(onDate: string): BusinessHoursException {
  return { on_date: onDate, is_open: true, start_minute: 7 * 60, end_minute: 20 * 60, note: null };
}

function hours(exceptions: BusinessHoursException[] = []) {
  return { zone: ZONE, rules: RULES, exceptions };
}

function agent(weekdays: number[], startMinute: number, endMinute: number) {
  return {
    timezone: ZONE,
    rules: weekdays.map((weekday) => ({ weekday, start_minute: startMinute, end_minute: endMinute })),
  };
}

/** Somebody on every advertised hour of the weekly pattern. */
const FULL_ROSTER = [agent([1, 2, 3, 4, 5, 6], 8 * 60, 20 * 60)];

interface Sent {
  key: string;
  cooldownMs: number;
  text: string;
}

async function tick(input: {
  exceptions?: BusinessHoursException[];
  agents: ReturnType<typeof agent>[] | null;
  nowMs?: number;
  horizonDays?: number | null;
  hoursReadable?: boolean;
}): Promise<{ verdict: RosterCoverageVerdict; notified: Sent[]; resolved: Sent[] }> {
  const notified: Sent[] = [];
  const resolved: Sent[] = [];
  const verdict = await runRosterCoverageCheck({
    coverage: coverageForRange({
      hours: input.hoursReadable === false ? null : hours(input.exceptions),
      agents: input.agents,
      horizonDays: input.horizonDays === undefined ? HORIZON_DAYS : input.horizonDays,
      nowMs: input.nowMs ?? SATURDAY_10AM,
    }),
    armed: true,
    notify: async (key, cooldownMs, text) => {
      notified.push({ key, cooldownMs, text });
    },
    resolve: async (key, text) => {
      resolved.push({ key, cooldownMs: 0, text });
      return true;
    },
    cooldownMs: { live: 111, upcoming: 222 },
  });
  return { verdict, notified, resolved };
}

// ------------------------------------------------------------ the control

// A roster covering every advertised hour raises nothing and clears both. Without
// this, a check hard wired to report a gap would satisfy every case below (L1).
{
  const { verdict, notified, resolved } = await tick({ agents: FULL_ROSTER });
  eq(verdict.status, "covered", "a fully rostered range reads as covered");
  eq(notified.length, 0, "a fully rostered range raises nothing");
  eq(
    resolved.map((r) => r.key).sort().join(","),
    [ROSTER_COVERAGE_KEY, ROSTER_COVERAGE_UPCOMING_KEY].sort().join(","),
    "a fully rostered range clears both keys, each off its own measured range",
  );
}

// ------------------------------------------------ a gap inside the horizon

// Wednesday 30 September is the fourth open day from a Saturday (Saturday itself,
// then Monday, Tuesday, Wednesday; Sunday is shut and does not count). So it is the
// last day a lead can reach right now, and a gap on it is live.
{
  const { verdict, notified } = await tick({
    exceptions: [earlyOpening("2026-09-30")],
    agents: FULL_ROSTER,
  });
  eq(verdict.status, "gaps", "a gap just inside the horizon is a measured gap");
  eq(notified.length, 1, "it raises exactly one alert");
  eq(notified[0]?.key, ROSTER_COVERAGE_KEY, "a gap leads can reach raises the live key");
  eq(notified[0]?.cooldownMs, 111, "on the live key's own cooldown");
  const text = notified[0]?.text ?? "";
  assert(!/turned away/i.test(text), `the live wording does not claim leads are being turned away (${text})`);
  assert(
    /the booker is not offering them to leads booking now/.test(text),
    `the live wording says what leads booking now actually meet (${text})`,
  );
  // Four days out from a Saturday morning: counted in days, never "93 hours".
  assert(
    text.startsWith("In about 4 days from this message, at 07:00 on Wednesday Sep 30,"),
    `a gap days away leads with when it starts, in days (${text})`,
  );
  assert(!/right now|\bSince\b/.test(text), `a gap that has not started never claims to be happening (${text})`);
  assert(text.includes("Wednesday Sep 30"), `it names the date, not only the weekday (${text})`);
  assert(text.includes("07:00 to 08:00"), `it names the uncovered stretch (${text})`);
  assert(!/nothing is broken/i.test(text), "the live wording never says nothing is broken");
}

// ------------------------------------------------ a gap a week out

// Monday 5 October is past the horizon (which ends with Wednesday 30 September) and
// inside the lead time. Nothing is broken yet; somebody has time to act.
{
  const { verdict, notified, resolved } = await tick({
    exceptions: [earlyOpening("2026-10-05")],
    agents: FULL_ROSTER,
  });
  eq(verdict.status, "gaps", "a gap a week out is a measured gap");
  eq(notified.length, 1, "it raises exactly one alert");
  eq(notified[0]?.key, ROSTER_COVERAGE_UPCOMING_KEY, "a gap past the horizon raises the upcoming key");
  eq(notified[0]?.cooldownMs, 222, "on the upcoming key's own cooldown");
  const text = notified[0]?.text ?? "";
  assert(/nothing is broken yet/i.test(text), `the upcoming wording says nothing is broken yet (${text})`);
  assert(/cover/i.test(text) && /working hours/i.test(text), `it names the human remedies (${text})`);
  assert(!/turned away/i.test(text), "the upcoming wording does not claim leads are being turned away");
  assert(text.includes("Monday Oct 5"), `it names the date (${text})`);
  eq(
    resolved.map((r) => r.key).join(","),
    ROSTER_COVERAGE_KEY,
    "the live range measured clear, so the live key clears and the upcoming one does not",
  );
}

// The two wordings must differ: a notice about next week must not read like a page
// about this morning (L11).
{
  const near = await tick({ exceptions: [earlyOpening("2026-09-30")], agents: FULL_ROSTER });
  const far = await tick({ exceptions: [earlyOpening("2026-10-05")], agents: FULL_ROSTER });
  assert(near.notified[0]?.text !== far.notified[0]?.text, "live and upcoming wording differ");
}

// ------------------------------------------------ when the live gap starts mattering (#3054)

// The page Slack received on Friday 2026-10-02 at 20:10 Eastern said leads were
// "being turned away" from a gap twelve hours off. Nobody was being refused: a lead
// booking then simply could not pick Saturday 08:00. So the live wording leads with
// WHEN the gap starts, judged from the gap's own start against the send time the
// runner passes in, and says "Since" only for a gap already running at that moment.
const AT = (localIso: string) => DateTime.fromISO(localIso, { zone: ZONE }).toMillis();
const FRIDAY = (hhmm: string) => AT(`2026-10-02T${hhmm}`);
const REMEDIES =
  "Set agents' working hours to cover them, or narrow the org's business hours so we stop advertising them.";

function liveText(notified: Sent[]): string {
  return notified.find((n) => n.key === ROSTER_COVERAGE_KEY)?.text ?? "";
}

// (a) A gap twelve hours away, the shape of the page the issue was filed about. The
// filed page was about a Saturday, which no longer pages at all (below), so the
// same twelve hour gap is driven on a Tuesday.
{
  const roster = [agent([1, 3, 4, 5, 6], 8 * 60, 20 * 60), agent([2], 9 * 60, 20 * 60)];
  const { notified } = await tick({ agents: roster, nowMs: AT("2026-10-05T20:10") });
  eq(
    liveText(notified),
    "In about 12 hours from this message, at 08:00 on Tuesday Oct 6, the org will be open with " +
      "nobody bookable rostered. The uncovered hours are 08:00 to 09:00 on Tuesday Oct 6 (the day " +
      "opens with nobody on), and the booker is not offering them to leads booking now. " +
      REMEDIES,
    "a gap twelve hours off says when it starts and what leads booking now meet",
  );
}

// (b) A gap already running at send time is the one case allowed to say it is happening.
{
  const roster = [
    agent([1, 2, 3, 4], 8 * 60, 20 * 60),
    agent([5], 8 * 60, 17 * 60),
    agent([6], 8 * 60, 20 * 60),
  ];
  const { notified } = await tick({ agents: roster, nowMs: FRIDAY("18:10") });
  eq(
    liveText(notified),
    "Since 17:00 on Friday Oct 2 the org has been open with nobody bookable rostered, and it still " +
      "is. The uncovered hours are 17:00 to 20:00 on Friday Oct 2, and the booker is not offering " +
      "them to leads booking now. " +
      REMEDIES,
    "a gap already running says since when, and that it still is",
  );
}

// (c) Several gaps across days: it leads with the EARLIEST, which is the one that
// matters first, and still lists every stretch with its dates. Nobody works
// Saturday in this roster either, and that whole day is left out (below).
{
  const roster = [agent([1, 2, 3, 4, 5], 8 * 60, 17 * 60)];
  const { notified } = await tick({ agents: roster, nowMs: FRIDAY("10:00") });
  eq(
    liveText(notified),
    "In about 7 hours from this message, at 17:00 on Friday Oct 2, the org will be open with nobody " +
      "bookable rostered. The uncovered hours are 17:00 to 20:00 on Friday Oct 2, Monday Oct 5, and " +
      "Tuesday Oct 6, and the booker is not offering them to leads booking now. " +
      REMEDIES,
    "several gaps lead with the earliest and list every stretch",
  );
}

// Under an hour away it says so rather than "In about 0 hours".
{
  const roster = [agent([1, 2, 3, 4, 5], 8 * 60, 17 * 60), agent([6], 8 * 60, 20 * 60)];
  const { notified } = await tick({ agents: roster, nowMs: FRIDAY("16:30") });
  const text = liveText(notified);
  assert(
    text.startsWith(
      "Within the hour, at 17:00 on Friday Oct 2, the org will be open with nobody bookable rostered.",
    ),
    `a gap under an hour off says within the hour (${text})`,
  );
}

// Between one and two hours reads as "an hour", never "1 hours".
{
  const roster = [agent([1, 2, 3, 4, 5], 8 * 60, 17 * 60), agent([6], 8 * 60, 20 * 60)];
  const { notified } = await tick({ agents: roster, nowMs: FRIDAY("15:50") });
  const text = liveText(notified);
  assert(text.startsWith("In about an hour from this message,"), `about an hour reads naturally (${text})`);
}

// The live all-clear answers the new wording, not the old "turned away" claim.
{
  const { resolved } = await tick({ agents: FULL_ROSTER });
  const recovery = resolved.find((r) => r.key === ROSTER_COVERAGE_KEY)?.text ?? "";
  eq(
    recovery,
    "From now on every hour the org says it is open inside the booking horizon has at least one " +
      "bookable agent rostered (Saturday hours are not checked), so the booker holds none of them back. " +
      "No action is needed.",
    "the live all-clear matches the live wording",
  );
}

// Neither all clear may claim Saturday is covered, since Saturday is never judged.
{
  const { formatRosterCoverageUpcomingRecovery } = await import("../src/lib/monitor/roster-coverage.ts");
  assert(
    formatRosterCoverageUpcomingRecovery(false).includes("Saturday hours are not checked"),
    "the upcoming all clear says Saturday is not checked",
  );
}

// ------------------------------------------------ the edges of the evaluated range

// The horizon ends with Wednesday 30 September, so the lead time runs seven
// calendar days from Thursday 1 October through Wednesday 7 October. Both ends are
// driven, so an off by one either way fails here.
{
  eq(STAFFING_LEAD_DAYS, 7, "the staffing lead time is a week");
  const lastDay = await tick({ exceptions: [earlyOpening("2026-10-07")], agents: FULL_ROSTER });
  eq(lastDay.notified[0]?.key, ROSTER_COVERAGE_UPCOMING_KEY, "the last day of the lead time is still watched");
  const firstUpcoming = await tick({ exceptions: [earlyOpening("2026-10-01")], agents: FULL_ROSTER });
  eq(
    firstUpcoming.notified[0]?.key,
    ROSTER_COVERAGE_UPCOMING_KEY,
    "the first day past the horizon is upcoming, not live",
  );
  const beyond = await tick({ exceptions: [earlyOpening("2026-10-08")], agents: FULL_ROSTER });
  eq(beyond.verdict.status, "covered", "a gap beyond the evaluated range is not seen");
  eq(beyond.notified.length, 0, "a gap beyond the evaluated range raises nothing");
}

// ------------------------------------------------ a week ahead, and today's gap

// Checked on a Saturday morning, with nobody rostered for the first hour of any
// Friday. Friday is past the four open day horizon, so next Friday's gap is seen a
// week ahead on the upcoming key. The old one week window ended tomorrow and could
// never have seen it. (#1936 was filed about a Saturday; Saturday gaps no longer
// page at all since #3054, so the same shape is driven on a Friday.)
{
  const roster = [agent([1, 2, 3, 4, 6], 8 * 60, 20 * 60), agent([5], 9 * 60, 20 * 60)];
  const { notified } = await tick({ agents: roster });
  eq(notified.length, 1, "one alert, for next Friday only");
  eq(notified[0]?.key, ROSTER_COVERAGE_UPCOMING_KEY, "next Friday's gap is on the upcoming key");
  const text = notified[0]?.text ?? "";
  assert(text.includes("Friday Oct 2"), `next Friday is named by date (${text})`);
}

// Today's gap counts while it is still running (at 08:30 the first hour is not
// over), and stops counting once it has ended (at 10:00 it is over).
{
  const roster = [agent([2, 3, 4, 5, 6], 8 * 60, 20 * 60), agent([1], 9 * 60, 20 * 60)];
  const running = await tick({ agents: roster, nowMs: AT("2026-09-28T08:30") });
  const live = running.notified.find((n) => n.key === ROSTER_COVERAGE_KEY);
  assert(live !== undefined, "a gap still running today raises the live key");
  assert(
    live!.text.startsWith("Since 08:00 on Monday Sep 28"),
    `and says it has been happening since it started (${live?.text})`,
  );
  const over = await tick({ agents: roster, nowMs: AT("2026-09-28T10:00") });
  const liveOver = over.notified.find((n) => n.key === ROSTER_COVERAGE_KEY);
  assert(
    liveOver === undefined || !liveOver.text.includes("Sep 28"),
    `today's gap, already over, is not reported (${liveOver?.text})`,
  );
}

// ------------------------------------------------ Saturday is never judged (Dan, 2026-10-02)

// Saturday is staffed thinly on purpose, so its uncovered hours raise neither key,
// whenever the check runs. A range whose ONLY gaps are on Saturdays is healthy, and
// sends both all-clears like any covered range.
{
  eq(ROSTER_COVERAGE_UNJUDGED_WEEKDAY, 6, "the unjudged weekday is Saturday");
  const saturdayOnly = [agent([1, 2, 3, 4, 5], 8 * 60, 20 * 60), agent([6], 9 * 60, 20 * 60)];
  for (const [label, nowMs] of [
    ["from a Saturday", SATURDAY_10AM],
    ["from a Friday evening, twelve hours before it", FRIDAY("20:10")],
  ] as const) {
    const { verdict, notified, resolved } = await tick({ agents: saturdayOnly, nowMs });
    eq(verdict.status, "covered", `a Saturday only gap reads as covered ${label}`);
    eq(notified.length, 0, `a Saturday only gap stays silent ${label}`);
    eq(
      resolved.map((r) => r.key).sort().join(","),
      [ROSTER_COVERAGE_KEY, ROSTER_COVERAGE_UPCOMING_KEY].sort().join(","),
      `a Saturday only range sends both all-clears ${label}`,
    );
  }
  // A whole uncovered Saturday is the same: nobody on Saturday at all is silent.
  const noSaturday = [agent([1, 2, 3, 4, 5], 8 * 60, 20 * 60)];
  const { notified } = await tick({ agents: noSaturday, nowMs: FRIDAY("10:00") });
  eq(notified.length, 0, "a whole uncovered Saturday stays silent");
}

// A Saturday gap beside a Monday one: the page names Monday only.
{
  const roster = [
    agent([2, 3, 4, 5], 8 * 60, 20 * 60),
    agent([1], 9 * 60, 20 * 60),
    agent([6], 9 * 60, 20 * 60),
  ];
  const { verdict, notified } = await tick({ agents: roster, nowMs: FRIDAY("10:00") });
  const text = liveText(notified);
  assert(text.includes("Monday Oct 5"), `the Monday gap is named (${text})`);
  assert(!text.includes("Saturday"), `the Saturday gap beside it is not (${text})`);
  assert(
    verdict.status === "gaps" && verdict.live.every((g) => g.weekday !== 6),
    "and the verdict carries no Saturday gap either",
  );
}

// ------------------------------------------------ Sunday sends nothing (Dan, 2026-10-02)

// On a Sunday (Eastern) the check still measures, but neither the page nor the
// all-clear is sent, so the alert state stands as it was and Monday's tick decides.
{
  eq(ROSTER_COVERAGE_QUIET_SEND_WEEKDAY, 7, "the quiet send day is Sunday");
  const mondayGap = [agent([2, 3, 4, 5, 6], 8 * 60, 20 * 60), agent([1], 9 * 60, 20 * 60)];
  const sunday = await tick({ agents: mondayGap, nowMs: AT("2026-10-04T10:00") });
  eq(sunday.verdict.status, "gaps", "a Sunday tick still measures the gap");
  eq(sunday.verdict.status === "gaps" && sunday.verdict.paged, false, "and records that it was not sent");
  eq(sunday.notified.length, 0, "a Sunday tick sends no page");
  eq(sunday.resolved.length, 0, "a Sunday tick sends no all-clear");

  const sundayCovered = await tick({ agents: FULL_ROSTER, nowMs: AT("2026-10-04T10:00") });
  eq(sundayCovered.verdict.status, "covered", "a covered Sunday still reads as covered");
  eq(sundayCovered.resolved.length, 0, "and still clears nothing, leaving the state for Monday");

  // Late Sunday Eastern is already Monday in UTC: the day is read in the org's zone.
  const lateSunday = await tick({ agents: mondayGap, nowMs: AT("2026-10-04T22:30") });
  eq(lateSunday.notified.length, 0, "late Sunday Eastern is still Sunday, so nothing is sent");

  const monday = await tick({ agents: mondayGap, nowMs: AT("2026-10-05T07:30") });
  const text = liveText(monday.notified);
  assert(
    text.startsWith("Within the hour, at 08:00 on Monday Oct 5,"),
    `the Monday tick after it sends the page (${text})`,
  );
}

// ------------------------------------------------ the day opens with nobody on

{
  const { notified } = await tick({ exceptions: [earlyOpening("2026-09-28")], agents: FULL_ROSTER });
  const text = notified.find((n) => n.key === ROSTER_COVERAGE_KEY)?.text ?? "";
  assert(/opens with nobody on/i.test(text), `a gap in the first hour says the day opens with nobody on (${text})`);
  eq(notified.length, 1, "the opening is emphasis on the same key, never a second alert");
  // Every fact once per message (L605): the parenthetical pins which gap opens
  // empty, so no second sentence restates what a lead meets at opening.
  assert(!/arriving when the org opens|nothing at all/i.test(text), `the opening is stated once, not twice (${text})`);
}

// The same on the upcoming key: next Friday opening empty is said once.
{
  const roster = [agent([1, 2, 3, 4, 6], 8 * 60, 20 * 60), agent([5], 9 * 60, 20 * 60)];
  const { notified } = await tick({ agents: roster });
  const text = notified.find((n) => n.key === ROSTER_COVERAGE_UPCOMING_KEY)?.text ?? "";
  eq((text.match(/opens with nobody on/g) ?? []).length, 1, `the upcoming opening is stated once (${text})`);
  assert(!/nothing at all/i.test(text), `and no second sentence restates it (${text})`);
}

// The control: a gap in the middle of the day does not claim the day opens empty.
{
  const roster = [agent([1, 2, 3, 4, 5, 6], 8 * 60, 12 * 60), agent([1, 2, 3, 4, 5, 6], 13 * 60, 20 * 60)];
  const { notified } = await tick({ agents: roster });
  assert(notified.length === 2, "a daily midday gap is live now and upcoming next week");
  for (const n of notified) {
    assert(!/opens with nobody/i.test(n.text), `a midday gap does not say the day opens empty (${n.text})`);
  }
}

// ------------------------------------------------ each all-clear follows its own range

// Near gap Monday 28 September (live), far gap Friday 2 October (upcoming). Filling
// one clears only its own alert.
{
  const exceptions = [earlyOpening("2026-09-28")];
  const fridayLate = [agent([1, 2, 3, 4, 6], 8 * 60, 20 * 60), agent([5], 9 * 60, 20 * 60)];
  const both = await tick({ exceptions, agents: fridayLate });
  eq(
    both.notified.map((n) => n.key).sort().join(","),
    [ROSTER_COVERAGE_KEY, ROSTER_COVERAGE_UPCOMING_KEY].sort().join(","),
    "a near and a far gap raise one alert each",
  );
  eq(both.resolved.length, 0, "with both gaps standing nothing clears");

  // Fill the far gap: somebody covers Friday from 08:00.
  const farFilled = await tick({ exceptions, agents: [...fridayLate, agent([5], 8 * 60, 9 * 60)] });
  eq(farFilled.resolved.map((r) => r.key).join(","), ROSTER_COVERAGE_UPCOMING_KEY, "filling the far gap clears the upcoming alert");
  eq(farFilled.notified.map((n) => n.key).join(","), ROSTER_COVERAGE_KEY, "and the near one stands");
  const farClear = farFilled.resolved[0]?.text ?? "";
  assert(/still open/i.test(farClear), `the upcoming all-clear says the near gap is still open (${farClear})`);

  // Fill the near gap instead: somebody covers Monday from 07:00.
  const nearFilled = await tick({ exceptions, agents: [...fridayLate, agent([1], 7 * 60, 8 * 60)] });
  eq(nearFilled.resolved.map((r) => r.key).join(","), ROSTER_COVERAGE_KEY, "filling the near gap clears the live alert");
  eq(nearFilled.notified.map((n) => n.key).join(","), ROSTER_COVERAGE_UPCOMING_KEY, "and the far one stands");
}

// ------------------------------------------------ nothing measured, nothing cleared

for (const [label, input] of [
  ["an unreadable roster", { agents: null }],
  ["an unreadable horizon", { agents: FULL_ROSTER, horizonDays: null }],
  ["unreadable business hours", { agents: FULL_ROSTER, hoursReadable: false }],
] as const) {
  const { verdict, notified, resolved } = await tick(input);
  eq(verdict.status, "skipped", `${label} reaches no verdict`);
  eq(notified.length, 0, `${label} raises nothing`);
  eq(resolved.length, 0, `${label} clears nothing`);
}

// ------------------------------------------------ the new key is registered everywhere

{
  const entry = ALERT_CATALOG.find((e) => e.key === ROSTER_COVERAGE_UPCOMING_KEY);
  eq(entry?.kind, "condition", "the upcoming key is a condition, so it has an all-clear");
  assert(
    (ALERT_KEYS as readonly string[]).includes(ROSTER_COVERAGE_UPCOMING_KEY),
    "the upcoming key is in ALERT_KEYS, so its cooldown resolves",
  );
  const cooldowns = codedCooldownMs() as Record<string, number>;
  assert(
    typeof cooldowns[ROSTER_COVERAGE_UPCOMING_KEY] === "number" && cooldowns[ROSTER_COVERAGE_UPCOMING_KEY] > 0,
    "the upcoming key has a real coded cooldown",
  );
  assert(
    cooldowns[ROSTER_COVERAGE_UPCOMING_KEY] !== cooldowns[ROSTER_COVERAGE_KEY],
    "the two keys are paced separately",
  );
}

finish();
