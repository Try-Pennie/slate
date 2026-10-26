// #2590: Slack is told when calendars are filling up across the whole roster, against
// the nearly full line an admin sets on Team capacity (Dan, 2026-10-21: "threshold
// notice but tie it to the threshold set in the admin panel"). This drives the rule
// and its copy offline:
//
//   1. the share is Team capacity's own (calls that fit against what the shifts could
//      hold), for each of the next two days leads can book, with advisors whose
//      calendar is not syncing and advisors out for the day left out of both sides;
//   2. with EVERY day at or over the line it posts (#4219), naming each day's share, the
//      decision it is for and nothing more (Dan, 2026-10-25), with an empty subject list and a band that rises
//      every five points the least full day is over, so it posts again only when that
//      day gets worse;
//   3. with any day under the line it sends the all clear, naming that day, and only then;
//   4. a failed read (the report, the line, a throw) posts nothing and clears nothing;
//   5. a failed post or all clear never throws out of the check;
//   6. the days judged are the booker's (#4064): after the 6 PM cutoff that is
//      tomorrow and the next open day, never today, although Team capacity's page
//      still leads with today (#3949); before it, today and tomorrow; and the
//      all clear links to the Team capacity page;
//   7. it speaks only from 8 AM up to 6 PM New York time, every day (Dan, 2026-10-26, who
//      asked for 9 AM and then moved it to 8 so the first post is early rather than late).
//      A reading outside those hours posts nothing, clears nothing and records nothing as
//      sent, so the first tick inside them (8:23 AM) judges that morning's numbers afresh.
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
import { DAYTIME_POSTING_HOURS } from "../src/lib/notify/posting-hours.ts";
import { CRON_ROUTES } from "../worker/cron-routes.ts";
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

// 1: the measurement.
const over = judgeRosterFill({ report: report(ROSTER), linePct: 85 });
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
}

const at = judgeRosterFill({ report: report(ROSTER), linePct: 82 });
assert(at.status === "measured" && at.over && at.band === 1, "exactly on the line counts as over, in band 1");

// #4219: every judged day must be over the line on its own (Dan, 2026-10-25: "Fire when
// the next two days cross 85%"). That evening a full Monday and an 81% Tuesday added up
// to 90% and paged, while Team capacity showed Tuesday under the line.
const FULL_THEN_81 = [advisor("a", [[0, 50], [10, 50], [10, 10]]), advisor("b", [[0, 50], [9, 50], [10, 10]])];
const split = judgeRosterFill({ report: report(FULL_THEN_81), linePct: 85 });
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
const bothOver = judgeRosterFill({ report: report(FULL_THEN_86), linePct: 85 });
assert(bothOver.status === "measured" && bothOver.over, "both days at or over the line is over");
// Together 93% (band 2), but the 86% day is what holds the condition, so its band is the one that counts.
assert(bothOver.status === "measured" && bothOver.band === fillBand(86, 85), "the band follows the least full day");
const emptyDay = judgeRosterFill({ report: report([advisor("a", [[0, 10], [0, 0], [10, 10]])]), linePct: 85 });
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
const unmeasurable = judgeRosterFill({ report: { measurable: false, reason: "calendars" }, linePct: 85 });
assert(unmeasurable.status === "unmeasured" && /calendars/.test(unmeasurable.why), "an unreadable report is unmeasured, naming the read");
const noLine = judgeRosterFill({ report: report(ROSTER), linePct: null });
assert(noLine.status === "unmeasured" && /line/.test(noLine.why), "an unreadable line is unmeasured, never the default");
const nobody = judgeRosterFill({ report: report([advisor("x", [[0, 0], [0, 0], [0, 0]])]), linePct: 85 });
assert(nobody.status === "unmeasured", "no capacity at all is unmeasured, never 0% or 100% booked");
const noWindow = judgeRosterFill({ report: report(ROSTER, []), linePct: 85 });
assert(noWindow.status === "unmeasured", "no days to judge is unmeasured");
const oneDay = judgeRosterFill({ report: report(ROSTER, ["2026-10-23"]), linePct: 80 });
assert(oneDay.status === "measured" && oneDay.days.length === 1, "a window of one day judges that day alone");
const notHeld = judgeRosterFill({ report: report(ROSTER, ["2026-10-23", "2026-10-26"]), linePct: 80 });
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
  const reading = judgeRosterFill({ report: r, linePct: 85 });
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
const filling = judgeRosterFill({ report: report(fullRoster), linePct: 85 }) as Extract<RosterFillReading, { status: "measured" }>;
const alert = formatRosterFillAlert(filling);
// Day one: 3 open of 30, 90%. Day two: 2 open of 30, 93%. Together 91%, which is never said:
// a reader takes one share for every day (#4219).
// Dan, 2026-10-25: the days and the decision, nothing more.
eq(
  alert.split("\n")[0],
  "Calendars are filling up: Thu Oct 22 is 90% full and Fri Oct 23 is 93% full. This is the point to consider turning ad spend down.",
  "the alert is each day's share and the decision it is for",
);
assert(!alert.includes("91%"), "and never the two days added together");
const fullDay = formatRosterFillAlert(bothOver as Extract<RosterFillReading, { status: "measured" }>);
assert(fullDay.includes("Thu Oct 22 is full and Fri Oct 23 is 86% full"), `a day with no call open is full, as the page says (${fullDay})`);
assert(!/85%|Team capacity|55 of 60|tier/i.test(alert), `and no line, link, counts or tiers (${alert})`);
eq(alert.split("\n")[1], "1 advisor whose calendar is not syncing is left out of these numbers.", "the one caveat on the shares stays, on its own line");
eq(formatRosterFillAlert({ ...filling, notCounted: 0 }).split("\n").length, 1, "and with nobody left out the alert is one line");
assert(!/^\W*slate/i.test(alert), "the alert does not open with Slate");
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
    notify: async (key, _ms, text, repeat) => {
      sent.push({ key, text, repeat });
    },
    resolve: async (key, text) => {
      resolved.push({ key, text });
      return true;
    },
    cooldownMs: 4 * 60 * 60_000,
    appBaseUrl: BASE,
    // 11 AM New York on a Monday: inside the posting hours, so these ticks speak.
    nowMs: Date.parse("2026-10-26T15:00:00Z"),
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

// 7: the posting hours. A fake dispatcher with the real one's memory: a post stamps the
// condition as firing, and an all clear posts only while it is (resolveAlert's marker).
function dispatcher() {
  const posts: { at: string; text: string; kind: "alert" | "all clear" }[] = [];
  let firing = false;
  let clock = "";
  return {
    posts,
    isFiring: () => firing,
    async tickAt(iso: string, over: Partial<Parameters<typeof runRosterFillCheck>[0]> = {}) {
      clock = iso;
      const logged: Record<string, unknown>[] = [];
      const result = await runRosterFillCheck({
        loadReport: async () => report(fullRoster),
        readLine: async () => 85,
        notify: async (_key, _ms, text) => {
          posts.push({ at: clock, text, kind: "alert" });
          firing = true;
        },
        resolve: async (_key, text) => {
          if (!firing) return false;
          posts.push({ at: clock, text, kind: "all clear" });
          firing = false;
          return true;
        },
        cooldownMs: 4 * 60 * 60_000,
        appBaseUrl: BASE,
        nowMs: Date.parse(iso),
        log: (f) => logged.push(f),
        ...over,
      });
      return { result, logged };
    },
  };
}
// A different roster that is also over the line, so a post can be told apart by its numbers.
const FULLER = [advisor("a", [[0, 20], [0, 20], [10, 10]]), advisor("b", [[1, 20], [2, 20], [10, 10]])];
const fullerText = formatRosterFillAlert(judgeRosterFill({ report: report(FULLER), linePct: 85 }) as Extract<RosterFillReading, { status: "measured" }>);
assert(fullerText !== alert, "the two rosters read differently, so the test can tell which one posted");

{
  // The post Dan saw: over the line at 1:23 AM.
  const d = dispatcher();
  const { result, logged } = await d.tickAt("2026-10-26T05:23:00Z");
  eq(result.status === "measured" && result.over, true, "1:23 AM is still measured as over the line");
  eq(d.posts.length, 0, "1:23 AM posts nothing");
  eq(d.isFiring(), false, "and records nothing as sent, so 8:23 AM is not taken for a repeat");
  eq(logged.find((f) => f.status === "measured")?.held, true, "the log line says the post was held");

  // 7:53 AM, the lane's last tick before the window: still held.
  await d.tickAt("2026-10-26T11:53:00Z");
  eq(d.posts.length, 0, "7:53 AM still posts nothing");

  // 8:23 AM, the lane's first tick inside the window, still over the line: posts once, with that
  // morning's numbers.
  await d.tickAt("2026-10-26T12:23:00Z", { loadReport: async () => report(FULLER) });
  eq(d.posts.length, 1, "8:23 AM, still over the line, posts");
  eq(d.posts[0]?.text, fullerText, "with the numbers read at 8:23 AM, never the overnight ones");
  eq(d.posts[0]?.at, "2026-10-26T12:23:00Z", "at 8:23 AM");
}
{
  // Over the line overnight, under it by 8 AM: nothing at all.
  const d = dispatcher();
  await d.tickAt("2026-10-26T05:23:00Z");
  await d.tickAt("2026-10-26T07:53:00Z");
  await d.tickAt("2026-10-26T12:23:00Z", { readLine: async () => 95 });
  eq(d.posts.length, 0, "a condition that cleared before 8 AM never posts, alert or all clear");
}
{
  // The edges, one fresh tick each.
  const edges: [string, boolean, string][] = [
    ["2026-10-26T11:59:00Z", false, "7:59 AM"],
    ["2026-10-26T12:00:00Z", true, "8:00 AM"],
    ["2026-10-26T21:59:00Z", true, "5:59 PM"],
    ["2026-10-26T22:00:00Z", false, "6:00 PM"],
    ["2026-10-31T12:23:00Z", true, "a Saturday at 8:23 AM"],
    ["2026-11-01T12:53:00Z", false, "7:53 AM on the day the clocks go back"],
    ["2026-11-01T13:23:00Z", true, "8:23 AM on the day the clocks go back"],
    ["2026-03-08T11:53:00Z", false, "7:53 AM on the day the clocks go forward"],
    ["2026-03-08T12:23:00Z", true, "8:23 AM on the day the clocks go forward"],
  ];
  for (const [iso, speaks, what] of edges) {
    const d = dispatcher();
    await d.tickAt(iso);
    eq(d.posts.length, speaks ? 1 : 0, `over the line at ${what} ${speaks ? "posts" : "posts nothing"}`);
  }
}
{
  // Posted in the afternoon, under the line at 2 AM: the all clear waits for the morning too.
  const d = dispatcher();
  await d.tickAt("2026-10-26T20:53:00Z");
  eq(d.posts.length, 1, "4:53 PM over the line posts");
  const { logged } = await d.tickAt("2026-10-27T06:00:00Z", { readLine: async () => 95 });
  eq(d.posts.length, 1, "a 2 AM reading under the line posts no all clear");
  eq(d.isFiring(), true, "and leaves the notice open for the morning");
  eq(logged.find((f) => f.status === "measured")?.held, true, "the held all clear is in the log");
  await d.tickAt("2026-10-27T11:53:00Z", { readLine: async () => 95 });
  eq(d.posts.length, 1, "nor at 7:53 AM");
  await d.tickAt("2026-10-27T12:23:00Z", { readLine: async () => 95 });
  eq(d.posts.at(-1)?.kind, "all clear", "8:23 AM still under the line sends the all clear");
  eq(d.isFiring(), false, "and the notice is cleared");
}
{
  // Posted in the afternoon, under the line overnight, over again by morning: no all clear at
  // all, and the morning reading goes to the dispatcher, whose daily repeat decides (#3801).
  const d = dispatcher();
  await d.tickAt("2026-10-26T20:53:00Z");
  await d.tickAt("2026-10-27T06:00:00Z", { readLine: async () => 95 });
  await d.tickAt("2026-10-27T12:23:00Z");
  eq(d.posts.filter((p) => p.kind === "all clear").length, 0, "a dip under the line that ended before 8 AM sends no all clear");
}
{
  // The hold is only as prompt as the lane: its first tick each day must land soon after 8 AM.
  const exprs = Object.entries(CRON_ROUTES)
    .filter(([, routes]) => (Array.isArray(routes) ? routes : [routes]).includes("/api/cron/capacity-history"))
    .map(([expr]) => expr);
  assert(exprs.length > 0, "the capacity history lane has a schedule");
  for (const expr of exprs) {
    const [minutes, ...rest] = expr.split(" ");
    eq(rest.join(" "), "* * * *", `${expr} runs every hour of every day, so it reaches 8 AM on each one`);
    // New York is a whole number of hours off UTC all year, so a minute past each UTC hour is
    // the same minute past 8 AM New York, on both sides of a clock change.
    const first = Math.min(...(minutes ?? "").split(",").map(Number));
    assert(Number.isInteger(first) && first < 30, `the lane's first tick in the window is ${first} minutes after it opens, within half an hour`);
    // Dan, 2026-10-26: early rather than late, so the first morning post is at 8:23 AM.
    eq(DAYTIME_POSTING_HOURS.fromMinute + first, 8 * 60 + 23, "the first morning tick inside the window is 8:23 AM");
    assert(DAYTIME_POSTING_HOURS.fromMinute + first < DAYTIME_POSTING_HOURS.toMinute, "and inside the window");
  }
}

finish();
