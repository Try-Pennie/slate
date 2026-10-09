// #1256: a quiet whisper when a pool is nearly full, before it hits zero.
//
// What this suite holds down:
//
//   1. The measurement is the supply page's own (#1254): the share is read off the
//      `counted` cells `bucketSupplyReport` produced, never recomputed. A pool's
//      codes carry one reading, so a pool is judged and named ONCE.
//   2. The window is the booker's (#3559): the days `offeredDays` names, POOLED.
//      Dan, 2026-10-09: judge "the next x days, x being the number of days shown
//      the booker", adding the days up, so a full today alone is not a finding
//      while a lead can still book Saturday or Monday. A day outside the window,
//      or closed, counts for nothing.
//   3. The threshold is a setting (default 10%), and the edge is pinned both ways:
//      fewer than the share open whispers, exactly the share does not.
//   4. The zero case is not notified twice (#1412): a pool the booked solid page is
//      already about is left to that page. With the scan's answer unknown, a pool
//      with nothing open is held back too, because it may be on that page.
//   5. Every state that is not a measurement stays quiet: an unmeasurable report, a
//      pool with no window, a window day the report cannot read or does not hold.
//   6. It is a whisper: info channel, never a page, and never an all clear.
//
// Run: node --experimental-strip-types scripts/test-bucket-fullness.ts
import {
  POOL_NEARLY_FULL_KEY,
  formatPoolNearlyFullNotice,
  judgePoolFullness,
  runPoolFullnessCheck,
} from "../src/lib/monitor/bucket-fullness.ts";
import type {
  BucketSupplyReport,
  BucketSupplyRow,
  SupplyCell,
} from "../src/lib/admin/bucket-supply.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const NOW_MS = Date.parse("2026-10-02T15:00:00.000Z");
// The report's columns: Friday to Tuesday, Sunday shut.
const DAYS = ["2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06"];
// What the booker shows on Friday morning: Friday, Saturday and Monday.
const WINDOW = ["2026-10-02", "2026-10-03", "2026-10-05"];
const SHARE = 0.1;

const counted = (booked: number, capacity: number): SupplyCell => ({
  kind: "counted",
  booked,
  capacity,
  share: booked / capacity,
});
const CLOSED: SupplyCell = { kind: "closed" };

/** A row by its Friday, Saturday and Monday cells; Sunday is shut and Tuesday,
 *  past the window, is wide open so it would dilute any share that counted it. */
function row(
  code: string,
  poolKey: string,
  poolLabel: string | null,
  [fri, sat, mon]: [SupplyCell, SupplyCell, SupplyCell],
  offeredDays: string[] | null = WINDOW,
): BucketSupplyRow {
  return {
    code,
    name: code,
    poolKey,
    poolLabel,
    depth: 4,
    effectiveDepth: 4,
    cacheState: "measured",
    computedAtMs: NOW_MS,
    freshness: "fresh",
    offeredLater: false,
    offeredDays,
    cells: [fri, sat, CLOSED, mon, counted(0, 100)],
  };
}

function report(rows: BucketSupplyRow[]): BucketSupplyReport {
  return {
    measurable: true,
    zone: "America/New_York",
    horizonDays: 4,
    nowMs: NOW_MS,
    days: DAYS.map((iso, i) => ({ iso, weekday: [5, 6, 7, 1, 2][i] })),
    rows,
    bucketListReadable: true,
    depthReadable: true,
  };
}

// --- 1 and 2: one pooled reading per pool, over the booker's days -------------
{
  // Dan's example: today full, Saturday 20 of 50 open, Monday 45 of 50 open. 65
  // of 148 is 44% open, so a lead can still book and nothing is said.
  const out = judgePoolFullness({
    report: report([row("111", "pool:low", "Low", [counted(48, 48), counted(30, 50), counted(5, 50)])]),
    bookedSolidCodes: [],
    openShare: SHARE,
  });
  assert(out.status === "measured", "a readable report is a measurement");
  if (out.status === "measured") {
    eq(out.nearlyFull.length, 0, "a full today alone is not nearly full when the strip has room");
    eq(out.judged, 1, "and the pool was judged");
  }
}
{
  const out = judgePoolFullness({
    report: report([
      // A pool of two codes, 5 of 148 open across the three days: named once.
      row("111", "pool:low", "Low", [counted(48, 48), counted(48, 50), counted(47, 50)]),
      row("112", "pool:low", "Low", [counted(48, 48), counted(48, 50), counted(47, 50)]),
      // Exactly 10% open (6 of 60) is NOT fewer than 10%.
      row("211", "pool:mid", "Medium", [counted(18, 20), counted(18, 20), counted(18, 20)]),
      // One fewer open start (5 of 60) is, which pins the edge from the other side.
      row("311", "pool:high", "High", [counted(19, 20), counted(18, 20), counted(18, 20)]),
    ]),
    bookedSolidCodes: [],
    openShare: SHARE,
  });
  assert(out.status === "measured", "measured");
  if (out.status === "measured") {
    eq(out.nearlyFull.map((p) => p.label), ["Low", "High"], "only the pools under the threshold are named");
    eq(out.nearlyFull[0]?.codes, ["111", "112"], "one entry for the pool, carrying both codes");
    eq(out.nearlyFull[0]?.open, 5, "open is summed over the window's days");
    eq(out.nearlyFull[0]?.capacity, 148, "and so is capacity; the shut Sunday and Tuesday past the window add nothing");
    eq(out.nearlyFull[0]?.days, WINDOW, "and it carries the days it was judged over");
    eq(out.judged, 3, "three pools were measured");
  }
}

// --- 3: the threshold is the setting's, not a constant --------------------------
{
  const rows = [row("211", "pool:mid", "Medium", [counted(18, 20), counted(18, 20), counted(18, 20)])];
  const at10 = judgePoolFullness({ report: report(rows), bookedSolidCodes: [], openShare: 0.1 });
  const at20 = judgePoolFullness({ report: report(rows), bookedSolidCodes: [], openShare: 0.2 });
  eq(at10.status === "measured" ? at10.nearlyFull.length : -1, 0, "10% open is not under a 10% line");
  eq(at20.status === "measured" ? at20.nearlyFull.length : -1, 1, "and is under a 20% line");
}

// --- 4: the zero case belongs to the booked solid page (#1412) -----------------
{
  const full: [SupplyCell, SupplyCell, SupplyCell] = [counted(21, 21), counted(20, 20), counted(20, 20)];
  const rows = [
    row("111", "pool:low", "Low", full),
    row("211", "pool:mid", "Medium", [counted(20, 20), counted(19, 20), counted(20, 20)]),
  ];
  const known = judgePoolFullness({ report: report(rows), bookedSolidCodes: ["111"], openShare: SHARE });
  if (known.status === "measured") {
    eq(known.nearlyFull.map((p) => p.label), ["Medium"], "a pool the booked solid page already names is not whispered about as well");
  } else {
    assert(false, "measured");
  }
  // Positive control for the same fixture: when the page is NOT about it, a full
  // window IS fewer than 10% open, and the whisper names it.
  const notPaged = judgePoolFullness({ report: report(rows), bookedSolidCodes: [], openShare: SHARE });
  if (notPaged.status === "measured") {
    eq(notPaged.nearlyFull.map((p) => p.label), ["Low", "Medium"], "a full window the booked solid page is not about is still worth the whisper");
  } else {
    assert(false, "measured");
  }
  // The scan's answer unknown: a pool with nothing open may be on that page, so it
  // is held back, and a pool with something open is still named.
  const unknown = judgePoolFullness({ report: report(rows), bookedSolidCodes: null, openShare: SHARE });
  if (unknown.status === "measured") {
    eq(unknown.nearlyFull.map((p) => p.label), ["Medium"], "unknown scan: a full pool is held back");
  } else {
    assert(false, "measured");
  }
}

// --- 5: nothing that is not a measurement whispers -------------------------------
{
  const unmeasurable = judgePoolFullness({
    report: { measurable: false, reason: "business-hours" },
    bookedSolidCodes: [],
    openShare: SHARE,
  });
  eq(unmeasurable.status, "unmeasured", "an unmeasurable report is unmeasured, never an empty finding");

  const nearlyFull: [SupplyCell, SupplyCell, SupplyCell] = [counted(20, 20), counted(20, 20), counted(19, 20)];
  const quiet = judgePoolFullness({
    report: report([
      // No window: the booker could not say which days it shows.
      row("111", "pool:a", "A", nearlyFull, null),
      // One window day unreadable: a share over the other two would be a guess.
      row("211", "pool:b", "B", [counted(20, 20), { kind: "unknown" }, counted(19, 20)]),
      // A window day the report does not hold at all.
      row("311", "pool:c", "C", nearlyFull, ["2026-10-02", "2026-10-03", "2026-10-09"]),
      // Nothing countable on any window day.
      row("411", "pool:d", "D", [{ kind: "no-capacity" }, { kind: "nobody-available" }, { kind: "other-days" }]),
    ]),
    bookedSolidCodes: [],
    openShare: SHARE,
  });
  if (quiet.status === "measured") {
    eq(quiet.nearlyFull.length, 0, "no pool without a full reading of its window is named");
    eq(quiet.judged, 0, "and none of them counts as a pool judged");
  } else {
    assert(false, "measured");
  }
  // Control: the same nearly full cells over a readable window ARE named, so the
  // silence above is the missing reading and not the cells.
  const control = judgePoolFullness({ report: report([row("111", "pool:a", "A", nearlyFull)]), bookedSolidCodes: [], openShare: SHARE });
  eq(control.status === "measured" ? control.nearlyFull.length : -1, 1, "the same cells over a readable window are named");
}

// --- 6: a whisper, on the info channel, never resolved -------------------------
const nearlyFullLow = () => report([row("111", "pool:low", "Low", [counted(48, 48), counted(48, 50), counted(47, 50)])]);
{
  const sent: { key: string; cooldown: number; text: string }[] = [];
  const result = await runPoolFullnessCheck({
    loadReport: async () => nearlyFullLow(),
    bookedSolidCodes: [],
    openShare: SHARE,
    notify: async (key, cooldown, text) => {
      sent.push({ key, cooldown, text });
    },
    cooldownMs: 1234,
  });
  eq(result.status, "measured", "the run reports the measurement");
  eq(sent.length, 1, "one whisper");
  eq(sent[0]?.key, POOL_NEARLY_FULL_KEY, "on the nearly full key");
  eq(sent[0]?.cooldown, 1234, "on the configured cooldown");
  assert(sent[0]?.text.includes("Low: 5 of 148 starts still open.") === true, `naming the pool and its total: ${sent[0]?.text}`);

  // Nothing nearly full: nothing sent, and nothing to resolve (an info never ends).
  const silent: string[] = [];
  await runPoolFullnessCheck({
    loadReport: async () => report([row("111", "pool:low", "Low", [counted(2, 21), counted(2, 21), counted(2, 21)])]),
    bookedSolidCodes: [],
    openShare: SHARE,
    notify: async (key) => {
      silent.push(key);
    },
    cooldownMs: 1,
  });
  eq(silent.length, 0, "a healthy window sends nothing");

  // A failed load is unmeasured and sends nothing, never "no pool is nearly full".
  const failed: string[] = [];
  const out = await runPoolFullnessCheck({
    loadReport: async () => {
      throw new Error("bookings read failed");
    },
    bookedSolidCodes: [],
    openShare: SHARE,
    notify: async (key) => {
      failed.push(key);
    },
    cooldownMs: 1,
  });
  eq(out.status, "unmeasured", "a failed read is unmeasured");
  eq(failed.length, 0, "and it whispers nothing");

  // A refused Slack post must not fail the tick.
  const refusedLog: Record<string, unknown>[] = [];
  const refused = await runPoolFullnessCheck({
    loadReport: async () => nearlyFullLow(),
    bookedSolidCodes: [],
    openShare: SHARE,
    notify: async () => {
      throw new Error("slack 500");
    },
    cooldownMs: 1,
    log: (f) => refusedLog.push(f),
  });
  eq(refused.status, "measured", "a refused post still returns the measurement");
  assert(
    refusedLog.some((f) => f.status === "notify-failed" && String(f.why).includes("slack 500")),
    "and the refusal is logged, so a failed post never reads like a notice that was not due",
  );
}

// --- copy --------------------------------------------------------------------
{
  const one = formatPoolNearlyFullNotice([{ label: "Low", codes: ["111", "112"], open: 5, capacity: 148, days: WINDOW }], SHARE);
  eq(
    one,
    "1 pool has fewer than 10% of its possible starts still open across the days leads can book " +
      "(Fri Oct 2, Sat Oct 3, Mon Oct 5). Nothing is broken: the calendars are filling up, so this " +
      "is a nudge to add coverage before leads run out of times.\n" +
      "Low: 5 of 148 starts still open.",
    "the days are named once, and the pool gets one total",
  );
  const two = formatPoolNearlyFullNotice(
    [
      { label: "Low", codes: ["111"], open: 0, capacity: 148, days: WINDOW },
      { label: null, codes: ["999"], open: 1, capacity: 20, days: ["2026-10-03", "2026-10-05", "2026-10-06"] },
    ],
    0.2,
  );
  assert(two.startsWith("2 pools have fewer than 20% of their possible starts"), `plural agrees, at the set line: ${two}`);
  assert(two.includes("(Fri Oct 2, Sat Oct 3, Mon Oct 5, Tue Oct 6)"), `every pool's days are named, once each, in order: ${two}`);
  assert(two.includes("Low: none of 148 starts still open."), "a full window says none rather than 0 of");
  assert(two.includes("bucket 999"), "a pool with no name falls back to its code");
  eq(formatPoolNearlyFullNotice([], SHARE), "", "nothing to say is an empty string, so nothing is sent");
}

finish();
