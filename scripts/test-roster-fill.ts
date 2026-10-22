// #2590: Slack is told when calendars are filling up across the whole roster, against
// the nearly full line an admin sets on Team capacity (Dan, 2026-10-21: "threshold
// notice but tie it to the threshold set in the admin panel"). This drives the rule
// and its copy offline:
//
//   1. the share is Team capacity's own (calls that fit against what the shifts could
//      hold), added up over the next two days leads can book, with advisors whose
//      calendar is not syncing and advisors out for the day left out of both sides;
//   2. at or over the line it posts, naming the share, the counts, the days and the
//      fullest tiers, with an empty subject list and a band that rises every five
//      points, so it posts again only when the share gets worse;
//   3. under the line it sends the all clear, and only then;
//   4. a failed read (the report, the line, a throw) posts nothing and clears nothing;
//      a failed tier read still measures the roster and says the tiers are unknown;
//   5. a failed post or all clear never throws out of the check.
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
import type { AlertRepeat } from "../src/lib/notify/repeat-policy.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const DAYS = ["2026-10-22", "2026-10-23", "2026-10-24"];

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

function advisor(id: string, perDay: [number, number, boolean?][], unsynced = false): TeamCapacityAdvisor {
  return {
    id,
    name: id,
    email: `${id}@example.com`,
    timezone: "America/New_York",
    unsynced,
    days: perDay.map(([open, capacity, out], i) => day(DAYS[i]!, open, capacity, out ?? false)),
  };
}

function report(advisors: TeamCapacityAdvisor[], windowDays = DAYS): TeamCapacityReport {
  return {
    measurable: true,
    nowMs: Date.parse("2026-10-22T13:00:00.000Z"), // parse-ok: a literal
    zone: "America/New_York",
    windowDays,
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

// 2 and 3: the copy.
const fullRoster = [
  advisor("low-a", [[0, 10], [1, 10], [10, 10]]),
  advisor("low-b", [[1, 10], [0, 10], [10, 10]]),
  advisor("high-a", [[2, 10], [1, 10], [10, 10]]),
  advisor("broken", [[10, 10], [10, 10], [10, 10]], true),
];
const filling = judgeRosterFill({ report: report(fullRoster), linePct: 85, tierAgents: TIERS }) as Extract<RosterFillReading, { status: "measured" }>;
const alert = formatRosterFillAlert(filling);
assert(alert.includes("91%"), `the alert names the share (${alert})`);
assert(alert.includes("Thu Oct 22 and Fri Oct 23"), "the alert names the two days");
assert(alert.includes("85%"), "the alert names the line it was judged against");
assert(alert.includes("Team capacity"), "the alert says where the line is set");
assert(alert.includes("55 of 60"), "the alert gives the counts behind the share");
assert(/ad spend/i.test(alert), "the alert says what decision it is for");
assert(alert.includes("Low 95%") && alert.indexOf("Low") < alert.indexOf("High"), "the alert names the fullest tiers, fullest first");
assert(/1 advisor whose calendar is not syncing/.test(alert), "the alert says who is left out of the numbers");
assert(!/^\W*slate/i.test(alert), "the alert does not open with Slate");
const unknownTiers = formatRosterFillAlert({ ...filling, tiers: null });
assert(/tiers could not be read/i.test(unknownTiers), "an unknown tier read is said, not left out");
const recovery = formatRosterFillRecovery({ ...filling, bookedPct: 70, over: false, band: 0 });
assert(recovery.includes("70%") && recovery.includes("85%") && /cleared/.test(recovery), "the all clear names the share, the line, and that it cleared");

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
    ...over,
  });
  return { sent, resolved, result };
}

{
  const { sent, resolved } = await tick({});
  eq(sent.length, 1, "over the line posts once");
  eq(sent[0]?.key, ROSTER_FILLING_KEY, "on the roster filling key");
  eq(sent[0]?.repeat?.subjects?.length, 0, "with no subjects, so only a worse band reposts");
  eq(sent[0]?.repeat?.band, fillBand(91, 85), "with the band of the share");
  eq(resolved.length, 0, "and clears nothing");
}
{
  const { sent, resolved } = await tick({ readLine: async () => 95 });
  eq(sent.length, 0, "under the line posts nothing");
  eq(resolved.length, 1, "and sends the all clear off the measured reading");
  eq(resolved[0]?.key, ROSTER_FILLING_KEY, "on the same key");
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
