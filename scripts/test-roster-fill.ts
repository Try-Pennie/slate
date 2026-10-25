// #2590: Slack is told when calendars are filling up across the whole roster, against
// the nearly full line an admin sets on Team capacity (Dan, 2026-10-21: "threshold
// notice but tie it to the threshold set in the admin panel"). This drives the rule
// and its copy offline:
//
//   1. the share is Team capacity's own (calls that fit against what the shifts could
//      hold), for each of the next two days leads can book, with advisors whose
//      calendar is not syncing and advisors out for the day left out of both sides;
//   2. with EVERY day at or over the line it posts (#4219), naming each day's share, the
//      counts, and the fullest tiers, with an empty subject list and a band that rises
//      every five points the least full day is over, so it posts again only when that
//      day gets worse;
//   3. with any day under the line it sends the all clear, naming that day, and only then;
//   4. a failed read (the report, the line, a throw) posts nothing and clears nothing;
//      a failed tier read still measures the roster and says the tiers are unknown;
//   5. a failed post or all clear never throws out of the check;
//   6. the days judged are the booker's (#4064): after the 6 PM cutoff that is
//      tomorrow and the next open day, never today, although Team capacity's page
//      still leads with today (#3949); before it, today and tomorrow; and the
//      notice and its all clear link to the Team capacity page.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-roster-fill.ts
import {
  ROSTER_FILLING_KEY,
  fillBand,
  formatRosterFillAlert,
  formatRosterFillRecovery,
  judgeRosterFill,
  runRosterFillCheck,
  type RosterFillReading,
} from "../src/lib/monitor/roster-fill.ts";
import type { TeamCapacityReport } from "../src/lib/admin/team-capacity-load.ts";
import type { AdvisorDay, TeamCapacityAdvisor } from "../src/lib/admin/team-capacity.ts";
import { capacityDays } from "../src/lib/admin/capacity-days.ts";
import { offeredWindowFor } from "../src/lib/availability/offered-window.ts";
import type { AlertRepeat } from "../src/lib/notify/repeat-policy.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const DAYS = ["2026-10-22", "2026-10-23", "2026-10-24"];
const BASE = "https://slate.example";
const TEAM_CAPACITY_LINK = `<${BASE}/admin/team-capacity|Team capacity>`;

function day(iso: string, open: number, capacity: number, out = false): AdvisorDay {
  return {
    iso,
    open,
    capacity,
    out,
    noShift: capacity === 0,
    openTimes: [],
    shiftStart: null,
    shiftEnd: null,
    fullShiftStart: null,
    fullShiftEnd: null,
    timeOff: [],
  };
}

function advisor(id: string, perDay: [number, number, boolean?][], unsynced = false, isos = DAYS): TeamCapacityAdvisor {
  return {
    id,
    name: id,
    email: `${id}@example.com`,
    timezone: "America/New_York",
    unsynced,
    days: perDay.map(([open, capacity, out], i) => day(isos[i]!, open, capacity, out ?? false)),
  };
}

/** A report over DAYS whose booker's days are `bookerDays`; the page's are always DAYS. */
function report(advisors: TeamCapacityAdvisor[], bookerDays = DAYS): TeamCapacityReport {
  return {
    measurable: true,
    nowMs: Date.parse("2026-10-22T13:00:00.000Z"), // parse-ok: a literal
    zone: "America/New_York",
    windowDays: DAYS,
    bookerDays,
    days: DAYS,
    eventType: { duration_min: 20, slot_interval_min: 10, min_notice_min: 120, buffer_before_min: 10, buffer_after_min: 10, daily_cap: null },
    advisors,
  };
}

// Two Low advisors nearly full, one High advisor with room, one advisor out on day one,
// and one whose calendar is not syncing (wide open, which would drag the share down if
// it were counted). The third day is outside the two day window and is wide open.
const ROSTER = [
  advisor("low-a", [[1, 10], [1, 10], [10, 10]]),
  advisor("low-b", [[0, 10], [2, 10], [10, 10]]),
  advisor("high-a", [[4, 10], [3, 10], [10, 10]]),
  advisor("out-a", [[10, 10, true], [1, 10], [10, 10]]),
  advisor("broken", [[10, 10], [10, 10], [10, 10]], true),
];
const TIERS = new Map([
  ["1", ["low-a", "low-b"]],
  ["3", ["high-a"]],
  ["5", []],
]);

// 1: the measurement.
const over = judgeRosterFill({ report: report(ROSTER), linePct: 85, tierAgents: TIERS });
assert(over.status === "measured", "a readable report and line are measured");
if (over.status === "measured") {
  eq(over.days, ["2026-10-22", "2026-10-23"], "the next two days leads can book, never the third");
  // Day one: low-a 1/10, low-b 0/10, high-a 4/10 (out-a out, broken left out): open 5 of 30.
  // Day two: 1 + 2 + 3 + 1 open of 40. Together 12 open of 70: 58 taken, 82.857% booked.
  eq(over.open, 12, "open calls are summed over both days");
  eq(over.capacity, 70, "capacity leaves out the advisor out that day and the one not syncing");
  eq(over.bookedPct, 82, "the share is rounded down, as Team capacity rounds it");
  eq(over.notCounted, 1, "the advisor whose calendar is not syncing is counted as left out");
  eq(over.over, false, "82% is under an 85% line");
  eq(over.band, 0, "under the line is band 0");
  eq(over.tiers?.map((t) => [t.label, t.bookedPct]), [["Low", 90], ["High", 65]], "tiers fullest first, an empty tier left out");
}

const at = judgeRosterFill({ report: report(ROSTER), linePct: 82, tierAgents: TIERS });
assert(at.status === "measured" && at.over && at.band === 1, "exactly on the line counts as over, in band 1");

// #4219: every judged day must be over the line on its own (Dan, 2026-10-25: "Fire when
// the next two days cross 85%"). That evening a full Monday and an 81% Tuesday added up
// to 90% and paged, while Team capacity showed Tuesday under the line.
const FULL_THEN_81 = [advisor("a", [[0, 50], [10, 50], [10, 10]]), advisor("b", [[0, 50], [9, 50], [10, 10]])];
const split = judgeRosterFill({ report: report(FULL_THEN_81), linePct: 85, tierAgents: null });
assert(split.status === "measured", "a full day and a day under the line is measured");
if (split.status === "measured") {
  eq(split.bookedPct, 90, "together the two days are 90% booked, over the line");
  eq(
    split.perDay.map((d) => [d.day, d.bookedPct, d.open, d.capacity]),
    [["2026-10-22", 100, 0, 100], ["2026-10-23", 81, 19, 100]],
    "each day's own share, as Team capacity draws it",
  );
  eq(split.over, false, "one day under the line holds the notice back, however full the other");
  eq(split.band, 0, "and is band 0");
}
const FULL_THEN_86 = [advisor("a", [[0, 50], [7, 50], [10, 10]]), advisor("b", [[0, 50], [7, 50], [10, 10]])];
const bothOver = judgeRosterFill({ report: report(FULL_THEN_86), linePct: 85, tierAgents: null });
assert(bothOver.status === "measured" && bothOver.over, "both days at or over the line is over");
// Together 93% (band 2), but the 86% day is what holds the condition, so its band is the one that counts.
assert(bothOver.status === "measured" && bothOver.band === fillBand(86, 85), "the band follows the least full day");
const emptyDay = judgeRosterFill({ report: report([advisor("a", [[0, 10], [0, 0], [10, 10]])]), linePct: 85, tierAgents: null });
assert(
  emptyDay.status === "unmeasured" && /Fri Oct 23/.test(emptyDay.why),
  "a judged day nobody works is unmeasured, naming the day, never counted as full or empty",
);

// Bands: one per five points over the line, so drifting inside a band is no change.
eq(fillBand(84, 85), 0, "under the line");
eq(fillBand(85, 85), 1, "on the line");
eq(fillBand(89, 85), 1, "four points over is still band 1");
eq(fillBand(90, 85), 2, "five points over is band 2");
eq(fillBand(100, 85), 4, "fully booked is the top band for an 85 line");

// 4: what is not a reading.
const unmeasurable = judgeRosterFill({ report: { measurable: false, reason: "calendars" }, linePct: 85, tierAgents: TIERS });
assert(unmeasurable.status === "unmeasured" && /calendars/.test(unmeasurable.why), "an unreadable report is unmeasured, naming the read");
const noLine = judgeRosterFill({ report: report(ROSTER), linePct: null, tierAgents: TIERS });
assert(noLine.status === "unmeasured" && /line/.test(noLine.why), "an unreadable line is unmeasured, never the default");
const nobody = judgeRosterFill({ report: report([advisor("x", [[0, 0], [0, 0], [0, 0]])]), linePct: 85, tierAgents: TIERS });
assert(nobody.status === "unmeasured", "no capacity at all is unmeasured, never 0% or 100% booked");
const noWindow = judgeRosterFill({ report: report(ROSTER, []), linePct: 85, tierAgents: TIERS });
assert(noWindow.status === "unmeasured", "no days to judge is unmeasured");
const noTiers = judgeRosterFill({ report: report(ROSTER), linePct: 80, tierAgents: null });
assert(noTiers.status === "measured" && noTiers.over && noTiers.tiers === null, "a failed tier read still measures the roster");
const oneDay = judgeRosterFill({ report: report(ROSTER, ["2026-10-23"]), linePct: 80, tierAgents: TIERS });
assert(oneDay.status === "measured" && oneDay.days.length === 1, "a window of one day judges that day alone");
const notHeld = judgeRosterFill({ report: report(ROSTER, ["2026-10-23", "2026-10-26"]), linePct: 80, tierAgents: TIERS });
assert(notHeld.status === "unmeasured" && /every judged day/.test(notHeld.why), "a booker's day the report does not hold is unmeasured, never skipped");

// 6: which days are judged, through the same rule the page's days come from, at an
// injected clock. The office is open 8 AM to 8 PM Monday to Friday and the call needs
// 120 minutes' notice, as production holds; the booker offers four open days.
const OFFICE = {
  zone: "America/New_York",
  rules: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start_minute: 8 * 60, end_minute: 20 * 60 })),
  exceptions: [],
};
const NOTICE_MIN = 120;
const OFFERED = 4;
/** The page's days and the days the notice judges, with one busy advisor on every page day. */
function judgedAt(nowIso: string): { page: string[]; judged: string[] } {
  const nowMs = Date.parse(nowIso); // parse-ok: a literal
  const d = capacityDays(OFFICE, nowMs, NOTICE_MIN, OFFERED);
  if (d === null) return { page: [], judged: [] };
  const busy = advisor("busy", d.windowDays.map((): [number, number] => [1, 10]), false, d.windowDays);
  const base = report([busy]) as Extract<TeamCapacityReport, { measurable: true }>;
  const r: TeamCapacityReport = { ...base, nowMs, windowDays: d.windowDays, bookerDays: d.bookerDays, days: d.windowDays };
  const reading = judgeRosterFill({ report: r, linePct: 85, tierAgents: null });
  return { page: d.windowDays, judged: reading.status === "measured" ? reading.days : [] };
}
{
  // Wed 21 Oct, 11:53 PM in New York: the night the notice named Wednesday (#4064).
  const late = judgedAt("2026-10-22T03:53:00.000Z");
  eq(late.judged, ["2026-10-22", "2026-10-23"], "at 11:53 PM on a Wednesday the notice judges Thursday and Friday, never Wednesday");
  eq(late.page[0], "2026-10-21", "while Team capacity's page still leads with today after the cutoff (#3949)");
  // Thu 22 Oct, 11:53 PM: the next open day after Friday is Monday.
  eq(judgedAt("2026-10-23T03:53:00.000Z").judged, ["2026-10-23", "2026-10-26"], "at 11:53 PM on a Thursday it judges Friday and the next open day, Monday");
  // Wed 21 Oct, 2 PM: before the cutoff today is one of the booker's days.
  eq(judgedAt("2026-10-21T18:00:00.000Z").judged, ["2026-10-21", "2026-10-22"], "at 2 PM it judges today and tomorrow");
  // The cutoff itself: the booker stops counting today AT 6:00 PM (minute >= 18 * 60), so the notice does too.
  const cutoffMs = Date.parse("2026-10-21T22:00:00.000Z"); // parse-ok: a literal
  eq(judgedAt("2026-10-21T22:00:00.000Z").judged, ["2026-10-22", "2026-10-23"], "at exactly 6:00 PM it judges tomorrow and the day after");
  eq(
    judgedAt("2026-10-21T22:00:00.000Z").judged,
    offeredWindowFor(OFFICE, cutoffMs, NOTICE_MIN, OFFERED)?.days.slice(0, 2),
    "at the cutoff the booker's own rule decides",
  );
  // A minute before it the booker still offers today, so it is still judged.
  eq(judgedAt("2026-10-21T21:59:00.000Z").judged, ["2026-10-21", "2026-10-22"], "at 5:59 PM it still judges today and tomorrow, as the booker still offers today");
  // Sunday evening: the office is shut today, so neither list holds it.
  const sunday = judgedAt("2026-10-25T23:10:00.000Z");
  eq(sunday.judged, ["2026-10-26", "2026-10-27"], "on a Sunday evening it judges Monday and Tuesday");
  eq(sunday.page[0], "2026-10-26", "and the page does not add a shut today");
}

// 2 and 3: the copy.
const fullRoster = [
  advisor("low-a", [[0, 10], [1, 10], [10, 10]]),
  advisor("low-b", [[1, 10], [0, 10], [10, 10]]),
  advisor("high-a", [[2, 10], [1, 10], [10, 10]]),
  advisor("broken", [[10, 10], [10, 10], [10, 10]], true),
];
const filling = judgeRosterFill({ report: report(fullRoster), linePct: 85, tierAgents: TIERS }) as Extract<RosterFillReading, { status: "measured" }>;
const alert = formatRosterFillAlert(filling, BASE);
// Day one: 3 open of 30, 90%. Day two: 2 open of 30, 93%. Together 91%, which is never said:
// a reader takes one share for every day (#4219).
assert(alert.includes("Thu Oct 22 is 90% full and Fri Oct 23 is 93% full, both at or over"), `the alert names each day's own share (${alert})`);
assert(!alert.includes("91%"), "and never the two days added together");
const fullDay = formatRosterFillAlert(bothOver as Extract<RosterFillReading, { status: "measured" }>, BASE);
assert(fullDay.includes("Thu Oct 22 is full and Fri Oct 23 is 86% full"), `a day with no call open is full, as the page says (${fullDay})`);
assert(alert.includes("85%"), "the alert names the line it was judged against");
assert(alert.includes("Team capacity"), "the alert says where the line is set");
assert(alert.includes(TEAM_CAPACITY_LINK), `the alert links to the Team capacity page (${alert})`);
assert(alert.split("Team capacity").length === 2, "and names Team capacity once, as the link");
assert(alert.includes("55 of 60"), "the alert gives the counts behind the share");
assert(/ad spend/i.test(alert), "the alert says what decision it is for");
assert(alert.includes("Low 95%") && alert.indexOf("Low") < alert.indexOf("High"), "the alert names the fullest tiers, fullest first");
assert(/1 advisor whose calendar is not syncing/.test(alert), "the alert says who is left out of the numbers");
assert(!/^\W*slate/i.test(alert), "the alert does not open with Slate");
const unknownTiers = formatRosterFillAlert({ ...filling, tiers: null }, BASE);
assert(/tiers could not be read/i.test(unknownTiers), "an unknown tier read is said, not left out");
const recovery = formatRosterFillRecovery(split as Extract<RosterFillReading, { status: "measured" }>, BASE);
assert(
  recovery.includes("Fri Oct 23 is 81% full, under the 85%") && /cleared/.test(recovery),
  `the all clear names the day under the line, its share, the line, and that it cleared (${recovery})`,
);
assert(!recovery.includes("Thu Oct 22"), "and not the day still full, which is no room");
assert(recovery.includes(TEAM_CAPACITY_LINK), `the all clear links to the Team capacity page (${recovery})`);

// The check end to end, through fakes.
type Sent = { key: string; text: string; repeat?: AlertRepeat };
async function tick(over: Partial<Parameters<typeof runRosterFillCheck>[0]>) {
  const sent: Sent[] = [];
  const resolved: Sent[] = [];
  const result = await runRosterFillCheck({
    loadReport: async () => report(fullRoster),
    readLine: async () => 85,
    loadTierAgents: async () => TIERS,
    notify: async (key, _ms, text, repeat) => {
      sent.push({ key, text, repeat });
    },
    resolve: async (key, text) => {
      resolved.push({ key, text });
      return true;
    },
    cooldownMs: 4 * 60 * 60_000,
    appBaseUrl: BASE,
    ...over,
  });
  return { sent, resolved, result };
}

{
  const { sent, resolved } = await tick({});
  eq(sent.length, 1, "over the line posts once");
  eq(sent[0]?.key, ROSTER_FILLING_KEY, "on the roster filling key");
  eq(sent[0]?.repeat?.subjects?.length, 0, "with no subjects, so only a worse band reposts");
  eq(sent[0]?.repeat?.band, fillBand(90, 85), "with the band of the least full day");
  eq(resolved.length, 0, "and clears nothing");
  assert(sent[0]?.text.includes(TEAM_CAPACITY_LINK) ?? false, "the posted notice carries the Team capacity link");
}
{
  const { sent, resolved } = await tick({ readLine: async () => 95 });
  eq(sent.length, 0, "under the line posts nothing");
  eq(resolved.length, 1, "and sends the all clear off the measured reading");
  eq(resolved[0]?.key, ROSTER_FILLING_KEY, "on the same key");
  assert(resolved[0]?.text.includes(TEAM_CAPACITY_LINK) ?? false, "the posted all clear carries the Team capacity link");
}
{
  const logged: Record<string, unknown>[] = [];
  const { sent, resolved } = await tick({ loadReport: async () => report(FULL_THEN_81), log: (f) => logged.push(f) });
  eq(sent.length, 0, "a full day beside a day under the line posts nothing (#4219)");
  eq(resolved.length, 1, "and is a measured reading under the condition, so it clears");
  const line = logged.find((f) => f.status === "measured");
  eq(line?.day_pcts, "100,81", "the log line carries each day's share, which the band and the notice follow");
  eq(line?.booked_pct, 90, "beside the two days added up");
}
{
  const { sent, resolved, result } = await tick({ loadReport: async () => ({ measurable: false, reason: "time-off" }) });
  eq(result.status, "unmeasured", "an unreadable report is unmeasured");
  eq(sent.length, 0, "an unreadable report posts nothing");
  eq(resolved.length, 0, "an unreadable report clears nothing");
}
{
  const { sent, resolved } = await tick({
    loadReport: async () => {
      throw new Error("statement timeout");
    },
  });
  eq(sent.length, 0, "a report read that throws posts nothing");
  eq(resolved.length, 0, "a report read that throws clears nothing");
}
{
  const { sent, resolved } = await tick({ readLine: async () => null });
  eq(sent.length, 0, "an unreadable line posts nothing");
  eq(resolved.length, 0, "an unreadable line clears nothing");
}
{
  const { sent, resolved } = await tick({
    readLine: async () => {
      throw new Error("refused");
    },
  });
  eq(sent.length, 0, "a line read that throws posts nothing");
  eq(resolved.length, 0, "a line read that throws clears nothing");
}
{
  const { sent } = await tick({
    loadTierAgents: async () => {
      throw new Error("roster unreadable");
    },
  });
  eq(sent.length, 1, "a failed tier read still posts the roster reading");
  assert(/tiers could not be read/i.test(sent[0]?.text ?? ""), "and says the tiers are unknown");
}
{
  let threw = false;
  try {
    await tick({
      notify: async () => {
        throw new Error("slack down");
      },
    });
    await tick({
      readLine: async () => 95,
      resolve: async () => {
        throw new Error("slack down");
      },
    });
  } catch {
    threw = true;
  }
  assert(!threw, "a failed post or all clear never throws out of the check");
}

finish();
