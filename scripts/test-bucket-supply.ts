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
  sameSupplyReading,
  supplyPoolGroups,
  supplyTotals,
  xbcOrder,
  type BucketSupplyRow,
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
  ["120", { depth: 4, effectiveDepth: 3, poolKey: "pool-low-beyond", poolLabel: "Low with Beyond" }],
  ["110", { depth: 9, effectiveDepth: 9, poolKey: "pool-low", poolLabel: "Low" }],
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
    // Nothing booked unless a case says otherwise, which is production today.
    bookedByCodeAndDate: new Map(),
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
        // #1937: the cell is BOOKED out of POSSIBLE now. With nothing booked,
        // both buckets read as an honest zero against their own ceiling, and
        // the ceiling is what each is offering rather than one ideal agent's
        // grid, so the thin bucket's ceiling is smaller than the healthy one's.
        eq(b.booked, 0, "nothing is booked in the thin bucket");
        eq(b.capacity, 9, "and its ceiling is the times IT could take, not the day's");
        eq(b.share, 0, "so its share is zero");
        eq(o.booked, 0, "nothing is booked in the healthy bucket either");
        eq(o.capacity, 21, "whose ceiling is larger, because it offers more");
        eq(o.share, 0, "and its share is zero too");
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

// A bucket that really is offering nothing, with nothing booked either: the one
// cell that MUST be its own answer, or the page cannot say the thing it exists
// to say (#1937).
//
// It used to be a counted zero, and under a BOOKED share a zero would read as
// "nothing taken yet", which is the healthy state every other bucket is in
// today. Nobody being available is the opposite, so it is a kind of its own.
{
  // 110 is a rung on 120's ladder, so its times are put PAST the booker's
  // three day window: a rung with a window time would make today an overflow.
  const report = reportWith({
    cacheRows: [
      cachedRow("120", [], FRESH_STAMP),
      cachedRow(
        "110",
        slotsFrom1320(21).map((iso) => new Date(Date.parse(iso) + 3 * 24 * 60 * 60_000).toISOString()),
        FRESH_STAMP,
      ),
    ],
  });
  if (!report.measurable) {
    fail("an empty bucket does not take the report down");
  } else {
    const cell = report.rows.find((r) => r.code === "120")?.cells[0];
    eq(
      cell?.kind,
      "nobody-available",
      "a bucket offering nothing, with nothing booked, says nobody is available",
    );
    // And it is NOT confused with a bucket that is simply fully booked, which is
    // the opposite reading of the same empty offer list.
    const bookedOut = reportWith({
      cacheRows: [cachedRow("120", [], FRESH_STAMP)],
      buckets: [{ code: "120", name: "Bucket 120" }],
      bookedByCodeAndDate: new Map([["120", new Map([["2026-08-04", slotsFrom1320(6)]])]]),
    });
    if (!bookedOut.measurable) fail("a booked out bucket produces a report");
    else {
      const c = bookedOut.rows[0].cells[0];
      assert(c.kind === "counted", `a booked out day is counted (got ${c.kind})`);
      if (c.kind === "counted") eq(c.share, 1, "and reads as every possible time taken");
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
  // #1942: DEBT TIER first and descending, which is the axis the page is read
  // by. Ultra High (5) leads and Low (1) is last, with the backend digit as the
  // secondary sort inside a tier (110 before 120).
  eq(
    sorted.join(","),
    "521,320,220,110,120,zzz",
    "codes group by debt tier descending, then backend, with a non-XBC code last",
  );

  // THE TRAP THE ISSUE NAMED. An unreadable code sorts LAST, deliberately: it is
  // kept and put at the end rather than dropped. Every naive way of reversing an
  // ascending sort (negating the key, flipping the comparator) sends that
  // sentinel to the FRONT, so the page would open with the one row nobody can
  // read. The descent lives in the key instead, and this is what holds it there.
  for (const bad of ["zzz", "", "6000", "12", "1a2"]) {
    assert(
      xbcOrder(bad) === Number.MAX_SAFE_INTEGER,
      `an unreadable code keeps the last-place sentinel (${JSON.stringify(bad)})`,
    );
    assert(
      xbcOrder(bad) > xbcOrder("511"),
      `and sorts after every real code, including the first one (${JSON.stringify(bad)})`,
    );
    assert(
      xbcOrder(bad) > xbcOrder("100"),
      `and after the last one too (${JSON.stringify(bad)})`,
    );
  }

  // Ultra High really is first and Low really is last, asserted as the RULE
  // rather than as one sorted list: a list can be right for the five codes
  // somebody happened to pick.
  assert(
    xbcOrder("500") < xbcOrder("400") &&
      xbcOrder("400") < xbcOrder("300") &&
      xbcOrder("300") < xbcOrder("200") &&
      xbcOrder("200") < xbcOrder("100"),
    "every debt tier sorts ahead of the one below it",
  );
  // And the backend still separates within a tier, which is what keeps the
  // fifteen Beyond codes together.
  assert(
    xbcOrder("300") < xbcOrder("310") && xbcOrder("310") < xbcOrder("320"),
    "the backend digit orders rows inside one tier",
  );
  assert(
    xbcOrder("320") < xbcOrder("200"),
    "and never outranks the tier, so a whole tier stays together",
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
    const totals = supplyTotals(supplyPoolGroups(report.rows, report.nowMs), 0);
    eq(totals.measured, 2, "both buckets were measured today");
    // #1937: the headline counts inverted with the metric. "Offering the whole
    // of today" counted every bucket whose share ran over 100%, so it is gone.
    eq(totals.nothingBooked, 2, "with no bookings, both read as nothing booked");
    eq(totals.saturated, 0, "neither is fully booked");
    eq(totals.partBooked, 0, "and neither is part booked");
    eq(totals.nobodyAvailable, 0, "both have times to offer, so neither is unavailable");
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
    const totals = supplyTotals(supplyPoolGroups(report.rows, report.nowMs), 0);
    eq(totals.measured, 1, "only the readable bucket is counted as measured");
    eq(totals.unmeasured, 1, "and the unreadable one is reported as unmeasured");
    // The unreadable bucket contributes to `unmeasured` and to NOTHING else, so
    // the three share categories account for exactly the measured ones and no
    // bucket is counted twice or dropped (L517).
    eq(
      totals.saturated + totals.partBooked + totals.nothingBooked,
      totals.measured,
      "every measured bucket lands in exactly one share category",
    );
    eq(totals.nothingBooked, 1, "which here is the one readable bucket, with nothing booked");
  }
}

// The day columns follow the org's zone, not UTC: a 21:00 New York instant is
// tomorrow in UTC, and filing it under tomorrow would spend a column the reader
// does not have.
{
  const days = supplyDays(WEEK, 4, Date.parse("2026-08-05T03:30:00.000Z"));
  eq(days[0].iso, "2026-08-04", "late evening in New York is still today's column");
}

// --- the share is BOOKED out of POSSIBLE, and can never exceed 1 (#1937) -----
//
// The page showed shares of 117%, 168% and 189%, and Dan read them as "did we
// somehow book more appointments than we offered?". They were proof the two
// halves measured different things: the numerator counted the times the WHOLE
// POOL was offering (84 agents for bucket 100) and the denominator counted how
// many slots fit for ONE synthetic ideal agent. Agents set their own hours
// across seven zones, so their windows start at different minutes past the hour
// and the pool's union holds far more instants than any single grid.
//
// Dan's own reading of what the number should mean, on 2026-09-04: "what
// percentage of the possible appointment times have been booked".
{
  const DAY = "2026-08-04";
  const booked = (times: string[]) =>
    new Map([["120", new Map([[DAY, times]])]]);

  const reportBooked = (offered: string[], taken: string[]) =>
    bucketSupplyReport({
      hours: WEEK,
      horizonDays: 4,
      nowMs: AUG_4_1119_ET,
      buckets: [{ code: "120", name: "Bucket 120" }],
      depthByCode: DEPTHS,
      cacheRows: [cachedRow("120", offered, FRESH_STAMP)],
      bookedByCodeAndDate: booked(taken),
    });

  const todayCell = (r: ReturnType<typeof bucketSupplyReport>) => {
    if (!r.measurable) throw new Error("report was not measurable");
    const i = r.days.findIndex((d) => d.iso === DAY);
    return r.rows[0].cells[i];
  };

  // Nothing booked: an honest zero against a real ceiling, which is what every
  // bucket reads today, since cal.com still takes every lead.
  const none = todayCell(reportBooked(slotsFrom1320(8), []));
  assert(none.kind === "counted", `a day with times offered is counted (got ${none.kind})`);
  if (none.kind === "counted") {
    eq(none.booked, 0, "nothing booked reads as zero booked");
    eq(none.capacity, 8, "the ceiling is what could be booked");
    eq(none.share, 0, "and the share is zero");
  }

  // Half the times taken: the ceiling is what is still offered PLUS what is
  // already taken, both counted on the same grid from the same source, which is
  // what makes the two halves comparable at all.
  const half = todayCell(reportBooked(slotsFrom1320(8).slice(0, 4), slotsFrom1320(8).slice(4)));
  assert(half.kind === "counted", "a partly booked day is counted");
  if (half.kind === "counted") {
    eq(half.booked, 4, "the booked times are counted");
    eq(half.capacity, 8, "the ceiling is the times offered plus the times taken");
    eq(half.share, 0.5, "half booked is a half share");
  }

  // Fully booked: nothing left to offer, and everything that could be taken was.
  // A raw count of what is OFFERED reports this same day as empty.
  const full = todayCell(reportBooked([], slotsFrom1320(8)));
  assert(full.kind === "counted", "a fully booked day is counted, not empty");
  if (full.kind === "counted") {
    eq(full.share, 1, "every possible time taken is a full share");
    eq(full.booked, 8, "and the booked count is every one of them");
    eq(full.capacity, 8, "with the ceiling agreeing");
  }

  // THE DEFECT ITSELF. No combination may produce a share above 1: a displayed
  // share outside its own range is the only self-evident proof that the two
  // halves measure different things (L588).
  const shapes: [string, string[], string[]][] = [
    ["nothing taken", slotsFrom1320(8), []],
    ["everything taken", [], slotsFrom1320(8)],
    ["some of each", slotsFrom1320(3), slotsFrom1320(8).slice(3)],
    // A time that is BOTH offered and booked, which a double count would inflate.
    ["the same times twice", slotsFrom1320(8), slotsFrom1320(8)],
    // A booking at a time nothing is offered at, which is what a narrowed week
    // or an agent going away leaves behind.
    ["a booking outside what is offered", slotsFrom1320(2), slotsFrom1320(20).slice(12)],
  ];
  for (const [what, offered, taken] of shapes) {
    const c = todayCell(reportBooked(offered, taken));
    if (c.kind !== "counted") continue;
    assert(
      c.share >= 0 && c.share <= 1,
      `a share stays inside its own range (${what}: got ${c.share})`,
    );
    assert(
      c.booked <= c.capacity,
      `the booked count never exceeds the ceiling (${what}: got ${c.booked} of ${c.capacity})`,
    );
  }

  // A bucket offering nothing and holding nothing, on a day the office CAN hold
  // appointments, is nobody being available. Distinct from a booked out day
  // (which is a full share) and from a day that could never hold one.
  const nobody = todayCell(reportBooked([], []));
  assert(
    nobody.kind === "nobody-available",
    `a bucket with no times and no bookings says nobody is available (got ${nobody.kind})`,
  );

  // A booking count that could not be READ must never be scored as zero booked,
  // which would read as "nothing is taken" on every bucket at once (L11).
  const unreadable = bucketSupplyReport({
    hours: WEEK,
    horizonDays: 4,
    nowMs: AUG_4_1119_ET,
    buckets: [{ code: "120", name: "Bucket 120" }],
    depthByCode: DEPTHS,
    cacheRows: [cachedRow("120", slotsFrom1320(8), FRESH_STAMP)],
    bookedByCodeAndDate: null,
  });
  const un = todayCell(unreadable);
  assert(
    un.kind === "unknown",
    `an unreadable booking count is unknown, never zero booked (got ${un.kind})`,
  );
}

// ---------------------------------------------------------------------------
// Counting by POOL (2026-10-02). Booked times used to be attributed to the code
// a lead came in on, while the offered times belong to the whole pool, so a time
// taken through 112 vanished from 111's ceiling and every code understated its
// pool. Measured that day: the Low pool held 50 routed bookings under 111 and
// 171 under 112. The fixture puts bookings on ONE code only, which is the case
// the old arithmetic got wrong.
// ---------------------------------------------------------------------------
{
  const POOLED = new Map([
    ["110", { depth: 9, effectiveDepth: 9, poolKey: "pool-low", poolLabel: "Low" }],
    ["111", { depth: 9, effectiveDepth: 9, poolKey: "pool-low", poolLabel: "Low" }],
    ["120", { depth: 4, effectiveDepth: 3, poolKey: "pool-low-beyond", poolLabel: "Low with Beyond" }],
  ]);
  // The pool is offering the last 18 of 21 times; the first three were booked,
  // all of them through 110.
  const all = slotsFrom1320(21);
  const offered = all.slice(3);
  const taken = all.slice(0, 3);
  const report = bucketSupplyReport({
    hours: WEEK,
    horizonDays: 4,
    nowMs: AUG_4_1119_ET,
    buckets: [
      { code: "110", name: "Low | Both | No Legal Param" },
      { code: "111", name: "Low | Both | Legal" },
      { code: "120", name: "Low | Beyond | No Legal Param" },
    ],
    depthByCode: POOLED,
    cacheRows: [
      cachedRow("110", offered, FRESH_STAMP),
      cachedRow("111", offered, FRESH_STAMP),
      cachedRow("120", slotsFrom1320(9), FRESH_STAMP),
    ],
    bookedByCodeAndDate: new Map([["110", new Map([["2026-08-04", taken]])]]),
  });
  if (!report.measurable) {
    fail("the pooled case produces a report");
  } else {
    const byCode = new Map(report.rows.map((r) => [r.code, r]));
    const a = byCode.get("110")!;
    const b = byCode.get("111")!;
    eq(a.cells[0], { kind: "counted", booked: 3, capacity: 21, share: 3 / 21 }, "110 reports the pool's three bookings");
    eq(b.cells[0], a.cells[0], "111 reports the SAME pool reading although nothing was booked through it");
    eq(b.cells, a.cells, "every day of the two codes of one pool agrees");
    eq(a.poolKey, "pool-low", "the row carries staffing depth's pool key");
    eq(a.poolLabel, "Low", "and staffing depth's pool label");
    const other = byCode.get("120")!;
    eq(other.cells[0], { kind: "counted", booked: 0, capacity: 9, share: 0 }, "another pool's bookings never leak in");

    // Two calls at ONE start count once: the cell counts start times, not calls.
    const twice = bucketSupplyReport({
      hours: WEEK,
      horizonDays: 4,
      nowMs: AUG_4_1119_ET,
      buckets: [
        { code: "110", name: "Low | Both | No Legal Param" },
        { code: "111", name: "Low | Both | Legal" },
      ],
      depthByCode: POOLED,
      cacheRows: [cachedRow("110", offered, FRESH_STAMP), cachedRow("111", offered, FRESH_STAMP)],
      bookedByCodeAndDate: new Map([
        ["110", new Map([["2026-08-04", [all[0]]]])],
        // The same instant as Postgres spells it, through the sibling code.
        ["111", new Map([["2026-08-04", [all[0].replace(".000Z", "+00:00")]]])],
      ]),
    });
    if (twice.measurable) {
      eq(twice.rows[0].cells[0], { kind: "counted", booked: 1, capacity: 19, share: 1 / 19 }, "two calls at one start time are one booked start time");
    } else fail("the two calls case produces a report");

    // Totals count each POOL once, so the two Low codes are one measurement.
    const totals = supplyTotals(supplyPoolGroups(report.rows, report.nowMs), 0);
    eq(totals.measured, 2, "three codes in two pools are two measurements, not three");
    eq(totals.partBooked, 1, "the Low pool is part booked once");
    eq(totals.nothingBooked, 1, "and the Beyond pool has nothing booked");
    const groups = supplyPoolGroups(report.rows, report.nowMs);
    eq(groups.length, 2, "the two Low codes share one group");
    eq(groups.find((g) => g.key === "pool-low")?.codes, ["110", "111"], "the group lists both codes");
  }

  // With the roster unreadable there is no pool key, so each code stands alone
  // and only its own bookings count. That is the old arithmetic, and the page
  // says so rather than guessing at a pool.
  const alone = bucketSupplyReport({
    hours: WEEK,
    horizonDays: 4,
    nowMs: AUG_4_1119_ET,
    buckets: [
      { code: "110", name: "Low | Both | No Legal Param" },
      { code: "111", name: "Low | Both | Legal" },
    ],
    depthByCode: null,
    cacheRows: [cachedRow("110", offered, FRESH_STAMP), cachedRow("111", offered, FRESH_STAMP)],
    bookedByCodeAndDate: new Map([["110", new Map([["2026-08-04", taken]])]]),
  });
  if (alone.measurable) {
    const byCode = new Map(alone.rows.map((r) => [r.code, r]));
    eq(byCode.get("111")!.cells[0], { kind: "counted", booked: 0, capacity: 18, share: 0 }, "without a pool key a code counts only its own bookings");
    assert(byCode.get("110")!.poolKey !== byCode.get("111")!.poolKey, "and two codes never share an invented pool");
    eq(byCode.get("110")!.poolLabel, null, "nor an invented label");
  } else fail("the roster unreadable case produces a report");
}

// The sameness predicate: every field the table renders, and it must be able to
// say no, because a split pool is how a disagreement stays visible.
{
  const base: BucketSupplyRow = {
    code: "110",
    name: "Low | Both | No Legal Param",
    poolKey: "pool-low",
    poolLabel: "Low",
    depth: 9,
    effectiveDepth: 8,
    cacheState: "measured",
    computedAtMs: AUG_4_1119_ET - 30_000,
    freshness: "fresh",
    cells: [{ kind: "counted", booked: 3, capacity: 21, share: 3 / 21 }, { kind: "closed" }],
  };
  const sibling = { ...base, code: "111", name: "Low | Both | Legal" };
  assert(sameSupplyReading(base, sibling, AUG_4_1119_ET), "two codes with one reading are the same, whatever their code and name");
  assert(
    sameSupplyReading(base, { ...sibling, computedAtMs: AUG_4_1119_ET - 40_000 }, AUG_4_1119_ET),
    "two stamps that RENDER alike are the same reading",
  );
  const differs: [string, BucketSupplyRow][] = [
    ["depth", { ...sibling, depth: 8 }],
    ["effective depth", { ...sibling, effectiveDepth: 9 }],
    ["cache state", { ...sibling, cacheState: "unreadable" }],
    ["freshness", { ...sibling, freshness: "aging" }],
    ["rendered age", { ...sibling, computedAtMs: AUG_4_1119_ET - 5 * 60_000 }],
    ["a cell's count", { ...sibling, cells: [{ kind: "counted", booked: 4, capacity: 21, share: 4 / 21 }, { kind: "closed" }] }],
    ["a cell's kind", { ...sibling, cells: [{ kind: "unknown" }, { kind: "closed" }] }],
    ["the number of cells", { ...sibling, cells: [base.cells[0]] }],
    ["the pool label", { ...sibling, poolLabel: "Low with Beyond" }],
  ];
  for (const [what, other] of differs) {
    assert(!sameSupplyReading(base, other, AUG_4_1119_ET), `rows differing in ${what} are not the same reading`);
  }

  // A pool whose rows disagree is split, one group per row, and its totals count
  // each disagreeing row rather than picking a winner.
  const split = supplyPoolGroups([base, { ...sibling, depth: 3 }], AUG_4_1119_ET);
  eq(split.length, 2, "a pool whose codes disagree stays split");
  assert(split.every((g) => !g.uniform), "and each half says it was split");
  eq(supplyTotals(supplyPoolGroups([base, { ...sibling, depth: 3 }], AUG_4_1119_ET), 0).measured, 2, "a split pool counts each reading");
  eq(supplyTotals(supplyPoolGroups([base, sibling], AUG_4_1119_ET), 0).measured, 1, "a uniform pool counts once");
}

// ---------------------------------------------------------------------------
// What the BOOKER does with an empty pool (Dan, 2026-10-02: the page matches
// today's booker). It offers the next three open days, walks the router's ladder
// and serves the FIRST rung with any time inside that window, and only past the
// window when no rung has one. The fixture clock is Tuesday 2026-08-04 at 11:19
// ET with two hours' notice and a Monday to Saturday week, so the window is
// Tuesday, Wednesday and Thursday, and Friday onward is past it.
// ---------------------------------------------------------------------------
{
  const slotsOn = (iso: string, n: number) => {
    const first = Date.parse(`${iso}T17:20:00.000Z`);
    return Array.from({ length: n }, (_, i) => new Date(first + i * 10 * 60_000).toISOString());
  };
  const LABELS: Record<string, string> = {
    "522": "Ultra High with Beyond",
    "532": "Ultra High with Achieve",
    "512": "Ultra High",
    "422": "Very High with Beyond",
    "432": "Very High with Achieve",
    "412": "Very High",
    "322": "High with Beyond",
    "332": "High with Achieve",
    "312": "High",
  };
  const ladderReport = (cacheRows: CachedSlotRow[]) => {
    const codes = cacheRows.map((r) => r.bucket_code);
    return bucketSupplyReport({
      hours: WEEK,
      horizonDays: 4,
      nowMs: AUG_4_1119_ET,
      buckets: codes.map((code) => ({ code, name: `Bucket ${code}` })),
      depthByCode: new Map(
        codes.map((code) => [code, { depth: 1, effectiveDepth: 1, poolKey: `pool-${code}`, poolLabel: LABELS[code] ?? null }]),
      ),
      cacheRows,
      bookedByCodeAndDate: new Map(),
    });
  };
  const rowOf = (report: ReturnType<typeof ladderReport>, code: string) =>
    report.measurable ? report.rows.find((r) => r.code === code) : undefined;
  const on = (report: ReturnType<typeof ladderReport>, code: string, iso: string) => {
    if (!report.measurable) return undefined;
    const i = report.days.findIndex((d) => d.iso === iso);
    return rowOf(report, code)?.cells[i];
  };
  const lowRow = (code: string, slots: string[], withoutLow: string[]): CachedSlotRow => ({
    bucket_code: code,
    payload: { slots, slotsWithoutLow: withoutLow, eventType: { ...EVENT } },
    computed_at: FRESH_STAMP,
  });

  // 1. The pool has a time inside the window, so it serves itself: a window day
  // on which it has nothing is "other days here", never red and never an
  // overflow, even with a rung below offering that very day.
  const self = ladderReport([
    cachedRow("522", slotsOn("2026-08-06", 3), FRESH_STAMP),
    cachedRow("532", slotsOn("2026-08-04", 5), FRESH_STAMP),
  ]);
  eq(on(self, "522", "2026-08-04"), { kind: "other-days" }, "an empty window day of a pool with other window days reads other days here");
  eq(on(self, "522", "2026-08-05"), { kind: "other-days" }, "on every empty window day");
  eq(on(self, "522", "2026-08-06")?.kind, "counted", "its own window day is its own measurement");
  eq(on(self, "522", "2026-08-07"), { kind: "nobody-available" }, "a day past the window keeps its own state");
  eq(rowOf(self, "522")?.offeredLater, false, "a pool serving itself is not offered later days");
  if (self.measurable) {
    const totals = supplyTotals(supplyPoolGroups(self.rows, self.nowMs), 0);
    eq(totals.otherDays, 1, "today's other days here is counted on its own chip");
    eq(totals.nobodyAvailable, 0, "and kept out of nobody available");
    eq(totals.overflows, 0, "and out of overflows");
  }

  // 2. Nothing in the window: the FIRST rung with a window time serves the whole
  // window, even on a day that rung itself has nothing, because one rung is what
  // the booker serves. 512 has a time today, but 532 comes first.
  const over = ladderReport([
    cachedRow("522", [], FRESH_STAMP),
    cachedRow("532", slotsOn("2026-08-05", 2), FRESH_STAMP),
    cachedRow("512", slotsOn("2026-08-04", 2), FRESH_STAMP),
  ]);
  const toAchieve = { kind: "overflows", toPool: "Ultra High with Achieve" };
  eq(on(over, "522", "2026-08-04"), toAchieve, "a pool with nothing in the window overflows to the first rung with a window time");
  eq(on(over, "522", "2026-08-05"), toAchieve, "the same rung on every window day");
  eq(on(over, "522", "2026-08-06"), toAchieve, "including a day that rung has nothing");
  eq(on(over, "522", "2026-08-07"), { kind: "nobody-available" }, "and the cover never leaks past the window");
  if (over.measurable) {
    const totals = supplyTotals(supplyPoolGroups(over.rows, over.nowMs), 0);
    eq(totals.overflows, 1, "the overflowing pool counts once as an overflow");
  }

  // 3. A top tier code skips a lower rung whose only window times are Low
  // carriers', and lands on the next rung that has a time without one.
  const topTier = ladderReport([
    cachedRow("422", [], FRESH_STAMP),
    lowRow("322", slotsOn("2026-08-04", 4), []),
    lowRow("332", slotsOn("2026-08-05", 2), slotsOn("2026-08-05", 2)),
  ]);
  eq(on(topTier, "422", "2026-08-04"), { kind: "overflows", toPool: "High with Achieve" }, "a Low carrier only rung is skipped for a top tier code");
  const onlyLow = ladderReport([cachedRow("422", [], FRESH_STAMP), lowRow("322", slotsOn("2026-08-04", 4), [])]);
  eq(on(onlyLow, "422", "2026-08-04"), { kind: "nobody-available" }, "with only Low carriers lower down, a top tier pool stays red");

  // 4. No rung has a time in the window: red, and the row says whether the last
  // resort past the window finds anything.
  const later = ladderReport([
    cachedRow("522", [], FRESH_STAMP),
    cachedRow("532", slotsOn("2026-08-07", 2), FRESH_STAMP),
  ]);
  eq(on(later, "522", "2026-08-04"), { kind: "nobody-available" }, "nothing in the window on any rung stays nobody available");
  eq(rowOf(later, "522")?.offeredLater, true, "and the row knows the booker would offer later days");
  const nothing = ladderReport([cachedRow("522", [], FRESH_STAMP), cachedRow("532", [], FRESH_STAMP)]);
  eq(on(nothing, "522", "2026-08-04"), { kind: "nobody-available" }, "nothing anywhere is nobody available");
  eq(rowOf(nothing, "522")?.offeredLater, false, "with no later days to offer either");
  if (later.measurable) {
    const totals = supplyTotals(supplyPoolGroups(later.rows, later.nowMs), 0);
    eq(totals.nobodyAvailable, 2, "both empty pools count as nobody available today");
  }

  // Two codes of one pool whose readings differ do not share a row.
  const base: BucketSupplyRow = {
    code: "120",
    name: "Low | Beyond | No Legal Param",
    poolKey: "pool-low-beyond",
    poolLabel: "Low with Beyond",
    depth: 1,
    effectiveDepth: 1,
    cacheState: "measured",
    computedAtMs: AUG_4_1119_ET - 30_000,
    freshness: "fresh",
    offeredLater: false,
    cells: [{ kind: "overflows", toPool: "Low with Achieve" }],
  };
  assert(
    !sameSupplyReading(base, { ...base, code: "121", cells: [{ kind: "overflows", toPool: "Low" }] }, AUG_4_1119_ET),
    "overflowing to a different pool is a different reading",
  );
  assert(!sameSupplyReading(base, { ...base, code: "121", offeredLater: true }, AUG_4_1119_ET), "being offered later days is part of the reading");
  assert(sameSupplyReading(base, { ...base, code: "121" }, AUG_4_1119_ET), "the same reading is the same");
}

finish();
