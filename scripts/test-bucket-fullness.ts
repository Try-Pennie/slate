// #1256: a quiet whisper when a pool is nearly full for the day, before it hits zero.
//
// What this suite holds down:
//
//   1. The measurement is the supply page's own (#1254): the share is read off the
//      `counted` cell `bucketSupplyReport` produced for TODAY, never recomputed. A
//      pool's codes carry one reading, so a pool is judged and named ONCE.
//   2. The threshold is Dan's, and the edge is pinned both ways: fewer than 10% of
//      the day's possible starts still open whispers, exactly 10% does not.
//   3. The zero case is not notified twice (#1412): a pool the booked solid page is
//      already about is left to that page. With the scan's answer unknown, a pool
//      with nothing open is held back too, because it may be on that page.
//   4. Every state that is not a measurement stays quiet and says so: an
//      unmeasurable report, an unknown cell, a closed day, a day with nothing left.
//   5. It is a whisper: info channel, never a page, and never an all clear.
//
// Run: node --experimental-strip-types scripts/test-bucket-fullness.ts
import {
  POOL_NEARLY_FULL_KEY,
  POOL_NEARLY_FULL_OPEN_SHARE,
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

const TODAY = "2026-10-02";
const NOW_MS = Date.parse("2026-10-02T15:00:00.000Z");

function row(code: string, poolKey: string, poolLabel: string | null, today: SupplyCell): BucketSupplyRow {
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
    cells: [today, { kind: "counted", booked: 0, capacity: 20, share: 0 }],
  };
}

const counted = (booked: number, capacity: number): SupplyCell => ({
  kind: "counted",
  booked,
  capacity,
  share: booked / capacity,
});

function report(rows: BucketSupplyRow[]): BucketSupplyReport {
  return {
    measurable: true,
    zone: "America/New_York",
    horizonDays: 7,
    nowMs: NOW_MS,
    days: [
      { iso: TODAY, weekday: 5 },
      { iso: "2026-10-03", weekday: 6 },
    ],
    rows,
    bucketListReadable: true,
    depthReadable: true,
  };
}

// The constant is Dan's number, and the module must not quietly drift from it.
eq(POOL_NEARLY_FULL_OPEN_SHARE, 0.1, "the threshold is 10% of the day's possible starts still open");

// --- 1 and 2: one reading per pool, the edge pinned both ways ------------------
{
  const out = judgePoolFullness({
    report: report([
      // A pool of two codes, 2 of 21 open: under 10%, so it is named once.
      row("111", "pool:low", "Low", counted(19, 21)),
      row("112", "pool:low", "Low", counted(19, 21)),
      // Exactly 10% open is NOT fewer than 10%.
      row("211", "pool:mid", "Medium", counted(18, 20)),
      // Healthy.
      row("311", "pool:high", "High", counted(3, 20)),
    ]),
    todayIso: TODAY,
    bookedSolidCodes: [],
  });
  assert(out.status === "measured", "a readable report with today in it is a measurement");
  if (out.status === "measured") {
    eq(out.nearlyFull.length, 1, "only the pool under the threshold is named");
    eq(out.nearlyFull[0]?.label, "Low", "named by the pool, in words");
    eq(out.nearlyFull[0]?.codes, ["111", "112"], "one entry for the pool, carrying both codes");
    eq(out.nearlyFull[0]?.open, 2, "open is capacity less booked");
    eq(out.nearlyFull[0]?.capacity, 21, "capacity is the supply page's own");
    eq(out.judged, 3, "three pools were measured today");
  }
}

// --- 3: the zero case belongs to the booked solid page (#1412) -----------------
{
  const rows = [
    row("111", "pool:low", "Low", counted(21, 21)),
    row("211", "pool:mid", "Medium", counted(19, 20)),
  ];
  const known = judgePoolFullness({ report: report(rows), todayIso: TODAY, bookedSolidCodes: ["111"] });
  assert(known.status === "measured", "measured");
  if (known.status === "measured") {
    eq(
      known.nearlyFull.map((p) => p.label),
      ["Medium"],
      "a pool the booked solid page already names is not whispered about as well",
    );
  }
  // Positive control for the same fixture: when the page is NOT about it, a full
  // day IS fewer than 10% open, and the whisper names it. Without this the line
  // above could pass because full pools were never judged at all.
  const notPaged = judgePoolFullness({ report: report(rows), todayIso: TODAY, bookedSolidCodes: [] });
  if (notPaged.status === "measured") {
    eq(
      notPaged.nearlyFull.map((p) => p.label),
      ["Low", "Medium"],
      "a full day the booked solid page is not about is still worth the whisper",
    );
  } else {
    assert(false, "measured");
  }
  // The scan's answer unknown: a pool with nothing open may be on that page, so it
  // is held back, and a pool with something open is still named.
  const unknown = judgePoolFullness({ report: report(rows), todayIso: TODAY, bookedSolidCodes: null });
  if (unknown.status === "measured") {
    eq(unknown.nearlyFull.map((p) => p.label), ["Medium"], "unknown scan: a full pool is held back");
  } else {
    assert(false, "measured");
  }
}

// --- 4: nothing that is not a measurement whispers -------------------------------
{
  const unmeasurable = judgePoolFullness({
    report: { measurable: false, reason: "business-hours" },
    todayIso: TODAY,
    bookedSolidCodes: [],
  });
  eq(unmeasurable.status, "unmeasured", "an unmeasurable report is unmeasured, never an empty finding");

  const quiet = judgePoolFullness({
    report: report([
      row("111", "pool:a", "A", { kind: "unknown" }),
      row("211", "pool:b", "B", { kind: "closed" }),
      row("311", "pool:c", "C", { kind: "no-capacity" }),
      row("411", "pool:d", "D", { kind: "nobody-available" }),
      row("511", "pool:e", "E", { kind: "other-days" }),
    ]),
    todayIso: TODAY,
    bookedSolidCodes: [],
  });
  if (quiet.status === "measured") {
    eq(quiet.nearlyFull.length, 0, "no state but a counted share can be nearly full");
    eq(quiet.judged, 0, "and none of them counts as a pool judged");
  } else {
    assert(false, "measured");
  }

  const noToday = judgePoolFullness({
    report: report([row("111", "pool:a", "A", counted(20, 21))]),
    todayIso: "2026-10-09",
    bookedSolidCodes: [],
  });
  eq(noToday.status, "unmeasured", "a report that does not hold today has nothing to say about today");
}

// --- 5: a whisper, on the info channel, never resolved -------------------------
{
  const sent: { key: string; cooldown: number; text: string }[] = [];
  const result = await runPoolFullnessCheck({
    loadReport: async () => report([row("111", "pool:low", "Low", counted(19, 21))]),
    todayIso: TODAY,
    bookedSolidCodes: [],
    notify: async (key, cooldown, text) => {
      sent.push({ key, cooldown, text });
    },
    cooldownMs: 1234,
  });
  eq(result.status, "measured", "the run reports the measurement");
  eq(sent.length, 1, "one whisper");
  eq(sent[0]?.key, POOL_NEARLY_FULL_KEY, "on the nearly full key");
  eq(sent[0]?.cooldown, 1234, "on the configured cooldown");
  assert(sent[0]?.text.includes("Low") === true, "naming the pool");

  // Nothing nearly full: nothing sent, and nothing to resolve (an info never ends).
  const silent: string[] = [];
  await runPoolFullnessCheck({
    loadReport: async () => report([row("111", "pool:low", "Low", counted(2, 21))]),
    todayIso: TODAY,
    bookedSolidCodes: [],
    notify: async (key) => {
      silent.push(key);
    },
    cooldownMs: 1,
  });
  eq(silent.length, 0, "a healthy day sends nothing");

  // A failed load is unmeasured and sends nothing, never "no pool is nearly full".
  const failed: string[] = [];
  const out = await runPoolFullnessCheck({
    loadReport: async () => {
      throw new Error("bookings read failed");
    },
    todayIso: TODAY,
    bookedSolidCodes: [],
    notify: async (key) => {
      failed.push(key);
    },
    cooldownMs: 1,
  });
  eq(out.status, "unmeasured", "a failed read is unmeasured");
  eq(failed.length, 0, "and it whispers nothing");

  // A refused Slack post must not fail the tick.
  const refused = await runPoolFullnessCheck({
    loadReport: async () => report([row("111", "pool:low", "Low", counted(19, 21))]),
    todayIso: TODAY,
    bookedSolidCodes: [],
    notify: async () => {
      throw new Error("slack 500");
    },
    cooldownMs: 1,
  });
  eq(refused.status, "measured", "a refused post still returns the measurement");
}

// --- copy --------------------------------------------------------------------
{
  const one = formatPoolNearlyFullNotice([{ label: "Low", codes: ["111", "112"], open: 2, capacity: 21 }]);
  assert(one.startsWith("1 pool has"), `singular agrees with its count: ${one}`);
  assert(one.includes("2 of today's 21 starts"), "states the measurement");
  assert(!/[\u2014\u2013]/.test(one), "no dashes in the copy");
  const two = formatPoolNearlyFullNotice([
    { label: "Low", codes: ["111"], open: 0, capacity: 21 },
    { label: null, codes: ["999"], open: 1, capacity: 20 },
  ]);
  assert(two.startsWith("2 pools have"), `plural agrees with its count: ${two}`);
  assert(two.includes("none of today's 21"), "a full day says none rather than 0 of");
  assert(two.includes("999"), "a pool with no name falls back to its code");
  eq(formatPoolNearlyFullNotice([]), "", "nothing to say is an empty string, so nothing is sent");
}

finish();
