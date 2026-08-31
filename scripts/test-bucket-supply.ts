// #1254: per bucket, per day supply. What is being offered, against what the day
// could have held.
//
// Two things this suite exists to hold down, both of which are the difference
// between a page somebody can act on and one that quietly lies:
//
//   1. The MAXIMUM is the booker's own number. The anchor is the worked example
//      from the issue, measured in production on 2026-08-04: at 11:19 ET the
//      maximum was 21 (13:20 to 16:40 ET, ten minute grid, twenty minute call,
//      two hour notice, the day closing at 17:00 ET). Both ends of that fixture
//      are pinned, the clock and the stored week, so real time cannot walk it
//      into a different case (L130).
//   2. ZERO and COULD NOT READ never render alike. An unreadable cache, an
//      unreadable payload, a shut day, a day with nothing left after the notice
//      cutoff and a genuinely empty bucket are five answers, and four of them are
//      not "booked solid".
//
// Run: node --experimental-strip-types scripts/test-bucket-supply.ts
import {
  bucketSupplyReport,
  dayCapacity,
  freshnessOf,
  supplyDays,
  supplyTotals,
  xbcOrder,
  type CachedSlotRow,
  type SupplyEventType,
} from "../src/lib/admin/bucket-supply.ts";
import type { BusinessHoursRules } from "../src/lib/availability/compute.ts";
import {
  RECOMPUTE_FRESH_MS,
  STALE_ALARM_MS,
} from "../src/lib/availability/precompute-cron.ts";
import { assert, eq, fail, finish } from "./lib/harness.ts";

/** The org's week as the worked example had it: open until 17:00 ET. */
const WEEK: BusinessHoursRules = {
  zone: "America/New_York",
  rules: [1, 2, 3, 4, 5, 6].map((weekday) => ({
    weekday,
    start_minute: 9 * 60,
    end_minute: 17 * 60,
  })),
  exceptions: [],
};

/** The event type the worked example ran on. */
const EVENT: SupplyEventType = {
  duration_min: 20,
  slot_interval_min: 10,
  min_notice_min: 120,
  buffer_before_min: 0,
  buffer_after_min: 0,
};

// 2026-08-04 at 11:19 America/New_York. Pinned as an absolute instant, so the
// fixture's meaning (a Tuesday morning inside an open week) cannot drift.
const AUG_4_1119_ET = Date.parse("2026-08-04T15:19:00.000Z");

// ---------------------------------------------------------------------------
// The maximum, against the number production actually showed.
// ---------------------------------------------------------------------------
{
  const cap = dayCapacity(WEEK, EVENT, "2026-08-04", AUG_4_1119_ET);
  if (cap.state !== "open") {
    fail("the worked example's day reads as open");
  } else {
    eq(cap.max, 21, "the worked example's maximum is the 21 production showed");
  }

  // The same day with the clock wound back to before the working day starts:
  // notice no longer bites, so every slot from 09:00 to 16:40 counts. That is
  // 8 hours minus the 20 minute call, on a 10 minute grid, plus the first.
  const earlier = dayCapacity(WEEK, EVENT, "2026-08-04", Date.parse("2026-08-04T05:00:00.000Z"));
  if (earlier.state !== "open") fail("an early morning reading is still an open day");
  else eq(earlier.max, 47, "with the notice cutoff clear of the day, the whole window counts");

  // After the last bookable start the day is not booked out, it is over. That
  // has to be its own answer or it reads exactly like a fully booked bucket.
  const late = dayCapacity(WEEK, EVENT, "2026-08-04", Date.parse("2026-08-04T20:00:00.000Z"));
  if (late.state !== "open") fail("a late reading is still an open day");
  else eq(late.max, 0, "past the notice cutoff for the last slot, the day can hold nothing");
}

// A shut day is a real answer about the org, and it is not zero capacity.
{
  const sunday = dayCapacity(WEEK, EVENT, "2026-08-09", AUG_4_1119_ET);
  eq(sunday.state, "closed", "a day the weekly pattern shuts reads as closed");

  const shutByException = dayCapacity(
    { ...WEEK, exceptions: [{ on_date: "2026-08-05", is_open: false, start_minute: null, end_minute: null, note: "Company day" }] },
    EVENT,
    "2026-08-05",
    AUG_4_1119_ET,
  );
  eq(shutByException.state, "closed", "a date exception that shuts a day beats the weekly pattern");

  // And an exception that OPENS a normally shut day must produce a real maximum,
  // not zero. Taking the shift from the weekly pattern rather than from
  // windowOnDate is the plausible mistake here, and it reads as a closed Sunday.
  const openedSunday = dayCapacity(
    {
      ...WEEK,
      exceptions: [
        { on_date: "2026-08-09", is_open: true, start_minute: 10 * 60, end_minute: 12 * 60, note: "Overflow Sunday" },
      ],
    },
    EVENT,
    "2026-08-09",
    AUG_4_1119_ET,
  );
  if (openedSunday.state !== "open") {
    fail("a date exception that opens a shut day gives a real maximum");
  } else {
    eq(openedSunday.max, 11, "an opened two hour Sunday holds eleven twenty minute calls");
  }
}

// An unusable date must never be reported as a closed day: a closed day is a
// statement about the org, and a parse failure is not.
{
  let threw = false;
  try {
    dayCapacity(WEEK, EVENT, "not-a-date", AUG_4_1119_ET);
  } catch (err) {
    threw = err instanceof Error && err.message.includes("unusable date");
  }
  assert(threw, "an unusable date throws rather than reading as a shut day");
}

// ---------------------------------------------------------------------------
// The report, and every way it must refuse to answer.
// ---------------------------------------------------------------------------

const BUCKETS = [
  { code: "120", name: "Low | Beyond | No Legal Param" },
  { code: "110", name: "Low | Both | No Legal Param" },
];

const DEPTHS = new Map([
  ["120", { depth: 4, effectiveDepth: 3 }],
  ["110", { depth: 9, effectiveDepth: 9 }],
]);

/** Slots on 2026-08-04 at ten minute steps from 13:20 ET, `n` of them. */
function slotsFrom1320(n: number): string[] {
  const first = Date.parse("2026-08-04T17:20:00.000Z");
  return Array.from({ length: n }, (_, i) => new Date(first + i * 10 * 60_000).toISOString());
}

function cachedRow(code: string, slots: string[] | undefined, computedAt: string): CachedSlotRow {
  return {
    bucket_code: code,
    payload: { slots, eventType: { ...EVENT } },
    computed_at: computedAt,
  };
}

const FRESH_STAMP = new Date(AUG_4_1119_ET - 30_000).toISOString();

function reportWith(over: Partial<Parameters<typeof bucketSupplyReport>[0]> = {}) {
  return bucketSupplyReport({
    hours: WEEK,
    horizonDays: 4,
    nowMs: AUG_4_1119_ET,
    buckets: BUCKETS,
    depthByCode: DEPTHS,
    cacheRows: [
      cachedRow("120", slotsFrom1320(9), FRESH_STAMP),
      cachedRow("110", slotsFrom1320(21), FRESH_STAMP),
    ],
    ...over,
  });
}

// The happy path: the share separates thin from closed.
{
  const report = reportWith();
  if (!report.measurable) {
    fail("a readable week and a readable cache produce a report");
  } else {
    eq(report.days.length, 6, "the columns span the whole window the cache was computed over");
    eq(report.days[0].iso, "2026-08-04", "the first column is today in the org's zone");

    const beyond = report.rows.find((r) => r.code === "120");
    const both = report.rows.find((r) => r.code === "110");
    if (!beyond || !both) {
      fail("both buckets are on the report");
    } else {
      const b = beyond.cells[0];
      const o = both.cells[0];
      if (b.kind !== "counted" || o.kind !== "counted") {
        fail("today's cells are measured counts");
      } else {
        eq(b.open, 9, "the thin bucket's open count comes from the cache");
        eq(b.max, 21, "and it is measured against the same maximum the booker derives");
        assert(b.share > 0.42 && b.share < 0.43, "a thin bucket reads as a fraction, not as empty");
        eq(o.open, 21, "the healthy bucket is offering the whole day");
        eq(o.share, 1, "which reads as a full share");
      }
      eq(beyond.depth, 4, "depth comes from the routing criteria match, not bucket_members");
      eq(beyond.effectiveDepth, 3, "and the out-today figure rides with it");
      eq(beyond.freshness, "fresh", "a row computed seconds ago reads as fresh");
      eq(beyond.cacheState, "measured", "a complete payload reads as measured");
    }

    // Sunday is shut, and it must say so rather than showing a zero share.
    const sundayIndex = report.days.findIndex((d) => d.iso === "2026-08-09");
    assert(sundayIndex >= 0, "the window reaches the closed Sunday");
    eq(report.rows[0].cells[sundayIndex].kind, "closed", "a shut day is never counted as booked out");
    eq(report.bucketListReadable, true, "the bucket list read is reported as readable");
    eq(report.depthReadable, true, "and so is the roster read behind the depth column");
  }
}

// The failure path that matters most: an unreadable cache is its own screen.
{
  const report = reportWith({ cacheRows: null });
  eq(report.measurable, false, "an unreadable slot cache refuses to produce a report");
  if (!report.measurable) {
    eq(report.reason, "slot-cache", "and names the read that failed");
  }
}

// The other failure path: the maximum is derived entirely from the org's week, so
// a week that could not be read must take the whole page down rather than
// producing shares against a maximum nobody measured.
{
  // There is no "unreadable week" value to pass, because loadBusinessHours throws
  // rather than returning one. The loader turns that throw into this report, and
  // the guard below is what proves the shape exists and is distinct.
  const report = bucketSupplyReport({
    hours: WEEK,
    horizonDays: 4,
    nowMs: AUG_4_1119_ET,
    buckets: BUCKETS,
    depthByCode: DEPTHS,
    cacheRows: null,
  });
  assert(!report.measurable, "the unmeasurable shape carries no rows at all");
  if (!report.measurable) {
    assert(
      report.reason === "slot-cache" || report.reason === "business-hours",
      "and every unmeasurable reason is one the page can name",
    );
  }
}

// A bucket whose payload cannot be measured reads as unknown, never as zero.
{
  for (const broken of [
    { bucket_code: "120", payload: { eventType: { ...EVENT } }, computed_at: FRESH_STAMP },
    { bucket_code: "120", payload: { slots: slotsFrom1320(9) }, computed_at: FRESH_STAMP },
    { bucket_code: "120", payload: null, computed_at: FRESH_STAMP },
  ] as CachedSlotRow[]) {
    const report = reportWith({ cacheRows: [broken, cachedRow("110", slotsFrom1320(21), FRESH_STAMP)] });
    if (!report.measurable) {
      fail("one unreadable payload does not take the whole report down");
      continue;
    }
    const row = report.rows.find((r) => r.code === "120");
    if (!row) {
      fail("an unreadable bucket still gets a row");
      continue;
    }
    eq(row.cacheState, "unreadable", "an incomplete payload reads as unreadable");
    eq(row.cells[0].kind, "unknown", "and today's cell says unknown rather than zero");
    // The share is what somebody reads off the page, so it must not exist at all
    // for a bucket nothing could be measured for.
    assert(
      row.cells.every((c) => c.kind !== "counted"),
      "no share anywhere is computed for a bucket that could not be measured",
    );
    // The rest of the report is still real.
    const healthy = report.rows.find((r) => r.code === "110");
    assert(healthy?.cells[0].kind === "counted", "the readable bucket beside it is still measured");
  }
}

// A bucket with no cached row at all is waiting on the recompute lane. That is a
// different thing from a row whose payload is corrupt, and both are different
// from empty.
{
  const report = reportWith({ cacheRows: [cachedRow("110", slotsFrom1320(21), FRESH_STAMP)] });
  if (!report.measurable) {
    fail("a missing row does not take the report down");
  } else {
    const row = report.rows.find((r) => r.code === "120");
    eq(row?.cacheState, "missing", "a bucket with no row reads as never computed");
    eq(row?.computedAtMs, null, "with no stamp to report");
    eq(row?.freshness, "unknown", "and a freshness nobody can claim");
    eq(row?.cells[0].kind, "unknown", "its cells are unknown, not zero");
  }
}

// A bucket that really is offering nothing: this is the one cell that MUST read
// as a hard zero, or the page cannot answer the question it exists for.
{
  const report = reportWith({
    cacheRows: [cachedRow("120", [], FRESH_STAMP), cachedRow("110", slotsFrom1320(21), FRESH_STAMP)],
  });
  if (!report.measurable) {
    fail("an empty bucket does not take the report down");
  } else {
    const cell = report.rows.find((r) => r.code === "120")?.cells[0];
    if (cell?.kind !== "counted") {
      fail("an empty but readable bucket is counted, not unknown");
    } else {
      eq(cell.open, 0, "an empty bucket reads as zero open");
      eq(cell.max, 21, "against the maximum the day could have held");
      eq(cell.share, 0, "and a zero share");
    }
  }
}

// A day past this bucket's own horizon holds nothing because the allowance was
// already spent, which is not the same as being booked out.
{
  // Four days with times, so the fifth open column is beyond this bucket's reach.
  const spread = [
    ...slotsFrom1320(2),
    "2026-08-05T17:20:00.000Z",
    "2026-08-06T17:20:00.000Z",
    "2026-08-07T17:20:00.000Z",
  ];
  const report = reportWith({
    horizonDays: 4,
    cacheRows: [cachedRow("120", spread, FRESH_STAMP), cachedRow("110", slotsFrom1320(21), FRESH_STAMP)],
  });
  if (!report.measurable) {
    fail("the horizon case still produces a report");
  } else {
    const row = report.rows.find((r) => r.code === "120");
    const saturdayIndex = report.days.findIndex((d) => d.iso === "2026-08-08");
    assert(saturdayIndex >= 0, "the window reaches the open Saturday past the allowance");
    eq(
      row?.cells[saturdayIndex].kind,
      "beyond-horizon",
      "a day past the bucket's own allowance is never reported as booked out",
    );
  }
}

// The roster read failing must not blank the supply half of the page, and must
// never let a missing depth read as no eligible agents.
{
  const report = reportWith({ buckets: null, depthByCode: null });
  if (!report.measurable) {
    fail("an unreadable roster does not take the supply report down");
  } else {
    eq(report.depthReadable, false, "the report says the roster could not be read");
    eq(report.bucketListReadable, false, "and that the bucket list could not be read either");
    assert(
      report.rows.every((r) => r.depth === null && r.effectiveDepth === null),
      "and every depth is an explicit unknown, never zero",
    );
    assert(report.rows.length === 2, "the cache's own codes drive the rows instead");
    assert(
      report.rows.every((r) => r.cells[0].kind === "counted"),
      "while the counts beside them are still measured",
    );
  }
}

// ---------------------------------------------------------------------------
// Freshness, judged against the recompute lane's own windows.
// ---------------------------------------------------------------------------
{
  eq(freshnessOf(AUG_4_1119_ET - 1000, AUG_4_1119_ET), "fresh", "a recent row is fresh");
  eq(
    freshnessOf(AUG_4_1119_ET - (RECOMPUTE_FRESH_MS + 1000), AUG_4_1119_ET),
    "aging",
    "past the freshness window but before the alarm is normal aging",
  );
  eq(
    freshnessOf(AUG_4_1119_ET - (STALE_ALARM_MS + 1000), AUG_4_1119_ET),
    "stale",
    "past the alarm threshold is stale, on the same threshold that pages",
  );
  eq(freshnessOf(null, AUG_4_1119_ET), "unknown", "a stamp nobody could read is unknown, not fresh");

  // An unreadable stamp must land on the unknown side rather than parsing to NaN
  // and comparing false against every threshold, which reads as fresh.
  const report = reportWith({
    cacheRows: [
      cachedRow("120", slotsFrom1320(9), "not-a-timestamp"),
      cachedRow("110", slotsFrom1320(21), FRESH_STAMP),
    ],
  });
  if (!report.measurable) fail("an unreadable stamp does not take the report down");
  else {
    const row = report.rows.find((r) => r.code === "120");
    eq(row?.freshness, "unknown", "an unreadable computed_at never reads as fresh");
    eq(row?.computedAtMs, null, "and reports no epoch at all");
  }
}

// ---------------------------------------------------------------------------
// Ordering and totals.
// ---------------------------------------------------------------------------
{
  // Grouped by the backend digit, because that is where the 2026-08-04 pattern
  // lived: every partially blocked bucket was an x2y (Beyond) code.
  const codes = ["521", "120", "220", "110", "320", "zzz"];
  const sorted = [...codes].sort((a, b) => xbcOrder(a) - xbcOrder(b) || a.localeCompare(b));
  eq(
    sorted.join(","),
    "110,120,220,320,521,zzz",
    "codes group by backend digit, then by debt tier, with a non-XBC code last",
  );
}

{
  const report = reportWith({
    cacheRows: [
      cachedRow("120", slotsFrom1320(9), FRESH_STAMP),
      cachedRow("110", slotsFrom1320(21), new Date(AUG_4_1119_ET - STALE_ALARM_MS - 1000).toISOString()),
    ],
  });
  if (!report.measurable) {
    fail("the totals case produces a report");
  } else {
    const totals = supplyTotals(report.rows, 0);
    eq(totals.measured, 2, "both buckets were measured today");
    eq(totals.partial, 1, "one is partially open");
    eq(totals.fullyOpen, 1, "one is fully open");
    eq(totals.empty, 0, "and none is empty");
    eq(totals.stale, 1, "the stale row is counted as stale");
  }
}

// A total must never count what it could not measure.
{
  const report = reportWith({
    cacheRows: [
      { bucket_code: "120", payload: null, computed_at: FRESH_STAMP },
      cachedRow("110", slotsFrom1320(21), FRESH_STAMP),
    ],
  });
  if (!report.measurable) {
    fail("the unmeasured totals case produces a report");
  } else {
    const totals = supplyTotals(report.rows, 0);
    eq(totals.measured, 1, "only the readable bucket is counted as measured");
    eq(totals.unmeasured, 1, "and the unreadable one is reported as unmeasured");
    eq(totals.empty, 0, "an unreadable bucket is never counted as empty");
  }
}

// The day columns follow the org's zone, not UTC: a 21:00 New York instant is
// tomorrow in UTC, and filing it under tomorrow would spend a column the reader
// does not have.
{
  const days = supplyDays(WEEK, 4, Date.parse("2026-08-05T03:30:00.000Z"));
  eq(days[0].iso, "2026-08-04", "late evening in New York is still today's column");
}

finish();
