// #1938: making the bucket availability page readable by somebody seeing it for
// the first time.
//
// The issue's test for done is a person, not a checklist: somebody cold should
// be able to say what one cell means, name the pool most in trouble, and say
// whether the numbers are current, without reading the paragraph above the
// table. This suite holds down the three PURE decisions that make that possible,
// each of which is invisible in a screenshot and silent when it breaks.
//
//   1. The rows are RANKED. Sixty rows of near identical numbers in code order
//      cannot answer "which of these is in trouble", and the ranking has to sit
//      INSIDE the debt tier rather than replacing it (Dan on 2026-09-04 asked
//      for both, and both compose).
//   2. "Last computed" answers WHEN. A column headed with a question that
//      answers with a grade is the specific complaint the issue opens with.
//   3. ONE vocabulary. The summary line, the column headers and the key used to
//      name one state three ways, so nothing a reader learned in one place
//      helped them in another. There is now one record per state and both ends
//      of the page read it, which only holds while nothing can name a state the
//      key does not explain.
//
// Run: node --experimental-strip-types scripts/test-bucket-supply-readability.ts
import {
  bucketSupplyReport,
  dayIsClosed,
  tierOrder,
  troubleRank,
  supplyPoolGroups,
  supplyTotals,
  type BucketSupplyRow,
  type CachedSlotRow,
  type SupplyEventType,
} from "../src/lib/admin/bucket-supply.ts";
import {
  SUPPLY_ALARMING_STATES,
  SUPPLY_LEGEND,
  SUPPLY_SUMMARY_STATES,
  agentCountLabel,
  computedAtLabel,
  overflowNote,
  poolRowDetail,
  poolRowName,
  supplyCellTitle,
  freshnessLabel,
  relativeAge,
  supplyLegendEntry,
  type SupplyLegendId,
} from "../src/lib/admin/bucket-supply-copy.ts";
import type { BusinessHoursRules } from "../src/lib/availability/compute.ts";
import { assert, eq, fail, finish } from "./lib/harness.ts";

const WEEK: BusinessHoursRules = {
  zone: "America/New_York",
  rules: [1, 2, 3, 4, 5, 6].map((weekday) => ({
    weekday,
    start_minute: 9 * 60,
    end_minute: 17 * 60,
  })),
  exceptions: [],
};

const EVENT: SupplyEventType = {
  duration_min: 20,
  slot_interval_min: 10,
  min_notice_min: 120,
  buffer_before_min: 0,
  buffer_after_min: 0,
};

/** 2026-08-04 at 11:19 America/New_York, the same pinned Tuesday the sibling
 *  suite uses. Both ends of every fixture below are pinned, so real time cannot
 *  walk one into a different case (L130). */
const NOW = Date.parse("2026-08-04T15:19:00.000Z");
const FRESH_STAMP = new Date(NOW - 30_000).toISOString();
const STALE_STAMP = new Date(NOW - 60 * 60_000).toISOString();

function slotsFrom1320(n: number): string[] {
  const first = Date.parse("2026-08-04T17:20:00.000Z");
  return Array.from({ length: n }, (_, i) => new Date(first + i * 10 * 60_000).toISOString());
}

function cachedRow(code: string, slots: string[] | undefined, computedAt: string): CachedSlotRow {
  return { bucket_code: code, payload: { slots, eventType: { ...EVENT } }, computed_at: computedAt };
}

function codesOf(
  buckets: { code: string; name: string }[],
  cacheRows: CachedSlotRow[],
): string[] {
  const report = bucketSupplyReport({
    hours: WEEK,
    horizonDays: 4,
    nowMs: NOW,
    buckets,
    depthByCode: new Map(
      buckets.map((b) => [b.code, { depth: 4, effectiveDepth: 3, poolKey: `pool-${b.code}`, poolLabel: null }]),
    ),
    cacheRows,
    bookedByCodeAndDate: new Map(),
  });
  if (!report.measurable) {
    fail(`the fixture report is measurable (got ${report.reason})`);
    return [];
  }
  return report.rows.map((r) => r.code);
}

// ---------------------------------------------------------------------------
// 1. Which row is in trouble, and where the ranking is allowed to act.
// ---------------------------------------------------------------------------
{
  function rowWith(over: Partial<BucketSupplyRow>): BucketSupplyRow {
    return {
      code: "120",
      name: "n",
      poolKey: `pool-${over.code ?? "120"}`,
      poolLabel: null,
      depth: 4,
      effectiveDepth: 3,
      cacheState: "measured",
      computedAtMs: NOW - 30_000,
      freshness: "fresh",
      cells: [{ kind: "counted", booked: 0, capacity: 21, share: 0 }],
      ...over,
    };
  }

  // The order is over states the page ALREADY names, never over a threshold
  // invented for the ranking, so a reader can see why a row is at the top.
  eq(troubleRank(rowWith({ cells: [{ kind: "nobody-available" }] }), 0), 0, "nobody available leads");
  eq(troubleRank(rowWith({ cells: [{ kind: "unknown" }] }), 0), 1, "an unmeasured cell comes next");
  eq(
    troubleRank(rowWith({ freshness: "stale", computedAtMs: NOW - 60 * 60_000 }), 0),
    2,
    "a stale row comes after that",
  );
  eq(troubleRank(rowWith({}), 0), 3, "an ordinary measured row comes last");

  // A row with no cell for that day at all is not a measurement, and must never
  // fall through to the ordinary rank: that is the whole shape of this defect
  // class, an absence reading as a healthy answer (L215).
  eq(troubleRank(rowWith({ cells: [] }), 0), 1, "a missing cell ranks as unmeasured, not as fine");

  // A closed day leaves every row at one rank, which is correct: on a Sunday no
  // bucket is in trouble and the tier order stands alone. Asserted so a future
  // rank for `closed` cannot be added without somebody meeting this line.
  eq(troubleRank(rowWith({ cells: [{ kind: "closed" }] }), 0), 3, "a shut day ranks nobody");
}

// The two orderings COMPOSE, and this is the assertion that keeps either from
// quietly undoing the other. `220` is a higher debt tier than `110`, and `110`
// is the one in trouble.
{
  const buckets = [
    { code: "220", name: "Medium, healthy" },
    { code: "110", name: "Low, healthy" },
    { code: "120", name: "Low, nobody available" },
  ];

  // The troubled pool is deliberately the one the CODE order puts SECOND (110
  // sorts before 120 on the backend digit), so the two orderings disagree and
  // the assertion can tell them apart. Picking the pool that already sorts first
  // would be satisfied by the ranking doing nothing at all (L159).
  const calm = codesOf(buckets, [
    cachedRow("220", slotsFrom1320(9), FRESH_STAMP),
    cachedRow("110", slotsFrom1320(9), FRESH_STAMP),
    cachedRow("120", slotsFrom1320(9), FRESH_STAMP),
  ]);
  eq(calm.join(","), "220,110,120", "with nothing in trouble the code order stands");

  const codes = codesOf(buckets, [
    cachedRow("220", slotsFrom1320(9), FRESH_STAMP),
    cachedRow("110", slotsFrom1320(9), FRESH_STAMP),
    // No slots at all on an open day, and nothing booked: nobody available.
    cachedRow("120", [], FRESH_STAMP),
  ]);
  eq(
    codes.join(","),
    "220,120,110",
    "the tier stays the outer key and the troubled pool leads its own tier",
  );

  // And the trouble must not be able to jump a tier: a troubled LOW pool still
  // sits under a healthy MEDIUM one. This is the direction that silently undoes
  // #1942, because a flat trouble-first order looks entirely reasonable.
  const troubledLow = codesOf(
    [
      { code: "110", name: "Low, nobody available" },
      { code: "220", name: "Medium, healthy" },
    ],
    [cachedRow("110", [], FRESH_STAMP), cachedRow("220", slotsFrom1320(9), FRESH_STAMP)],
  );
  // A flat trouble-first order would answer `110,220` here, which is the shape
  // that silently undoes #1942 while looking entirely reasonable.
  eq(troubledLow.join(","), "220,110", "trouble ranks inside a tier, never across tiers");

  // A code the tier key cannot read is kept and put at the END, and no amount of
  // trouble may promote it: the page must not open with the row nobody can read.
  const unreadableCode = codesOf(
    [
      { code: "zzz", name: "Not an XBC" },
      { code: "110", name: "Low, healthy" },
    ],
    [cachedRow("zzz", [], FRESH_STAMP), cachedRow("110", slotsFrom1320(9), FRESH_STAMP)],
  );
  eq(unreadableCode.join(","), "110,zzz", "an unreadable code stays last however troubled it is");
  eq(tierOrder("zzz"), Number.MAX_SAFE_INTEGER, "an unreadable code sorts last by its own key");
  assert(tierOrder("510") < tierOrder("110"), "the tier key descends: Ultra High before Low");
}

// ---------------------------------------------------------------------------
// 2. Whether these numbers are current.
// ---------------------------------------------------------------------------
{
  eq(relativeAge(0), "just now", "an age under a minute is just now");
  eq(relativeAge(59_000), "just now", "still just now at 59 seconds");
  eq(relativeAge(60_000), "1 min ago", "one minute is singular");
  eq(relativeAge(2 * 60_000), "2 min ago", "two minutes reads in minutes");
  eq(relativeAge(59 * 60_000), "59 min ago", "minutes run to 59");
  eq(relativeAge(60 * 60_000), "1 hr ago", "an hour is singular");
  eq(relativeAge(5 * 60 * 60_000), "5 hr ago", "hours read in hours");
  eq(relativeAge(26 * 60 * 60_000), "1 day ago", "a day is singular");
  eq(relativeAge(72 * 60 * 60_000), "3 days ago", "days read in days");
  // A stamp from the future is a clock disagreement, not a negative age, and a
  // "-3 min ago" on the page would read as a bug in the numbers beside it.
  eq(relativeAge(-5_000), "just now", "a stamp from the future reads as just now");
  eq(relativeAge(-5 * 60_000), "just now", "five minutes into the future reads the same way");
  // An age that is not a number REFUSES rather than falling through to the last
  // branch, which is the arm that reads as the most confident ("NaN days ago").
  eq(relativeAge(Number.NaN), null, "an unreadable age is refused, not rendered");
  eq(relativeAge(Number.POSITIVE_INFINITY), null, "an infinite age is refused too");

  // The column now answers the question its header asks.
  eq(
    computedAtLabel("fresh", NOW - 2 * 60_000, NOW).label,
    "2 min ago",
    "a fresh row states its age",
  );
  eq(
    computedAtLabel("aging", NOW - 5 * 60_000, NOW).label,
    "5 min ago",
    "an aging row states its age too: normal aging is not a thing to act on",
  );
  // The two exceptions, and they are deliberate: an age past the alarm is a
  // thing to DO something about rather than a fact to weigh, and a row that was
  // never computed has no age at all. Never a blank, and never a bare zero.
  eq(computedAtLabel("stale", NOW - 60 * 60_000, NOW).label, freshnessLabel("stale").label,
    "a stale row keeps its word");
  eq(computedAtLabel("unknown", null, NOW).label, freshnessLabel("unknown").label,
    "a never computed row keeps its word");
  assert(
    computedAtLabel("unknown", null, NOW).label.trim().length > 0,
    "a never computed row never renders blank",
  );
  // A readable grade with an unreadable stamp must fall back to the WORD, never
  // to an age computed from a null (L50: a parsed value never feeds a comparison
  // directly). NaN here would render "NaN min ago".
  eq(
    computedAtLabel("fresh", null, NOW).label,
    freshnessLabel("fresh").label,
    "a missing stamp falls back to the grade rather than to an age",
  );
  // The same fallback on the other route into an unreadable age: `computedAtMs`
  // is typed `number | null` and NaN is a number, so the null check above does
  // not cover it. Without its own case the fallback branch ships untested and
  // renders the literal word null in the column (L1).
  eq(
    computedAtLabel("fresh", Number.NaN, NOW).label,
    freshnessLabel("fresh").label,
    "an unreadable stamp falls back to the grade, never to the word null",
  );

  // Its meaning survives, because the meaning is what a hover and a screen
  // reader get and it is the only place the grade is still stated.
  eq(
    computedAtLabel("aging", NOW - 5 * 60_000, NOW).meaning,
    freshnessLabel("aging").meaning,
    "the grade is still available as the cell's own sentence",
  );
}

// ---------------------------------------------------------------------------
// 3. One vocabulary, enforced rather than agreed.
// ---------------------------------------------------------------------------
{
  const ALL_IDS: SupplyLegendId[] = [
    "nobody-available",
    "saturated",
    "some",
    "none",
    "no-capacity",
    "beyond-horizon",
    "closed",
    "unknown",
    "overflows",
  ];
  for (const id of ALL_IDS) {
    const matches = SUPPLY_LEGEND.filter((e) => e.id === id);
    eq(matches.length, 1, `the key explains ${id} exactly once`);
  }
  eq(SUPPLY_LEGEND.length, ALL_IDS.length, "the key holds no state the union does not name");

  // Every state the summary counts is one the key explains, which is the whole
  // content of "one vocabulary": a chip naming a state with no entry would be a
  // word above the table that nothing below it defines.
  const totals = supplyTotals(supplyPoolGroups([], NOW), 0);
  for (const { totalsKey, legendId } of SUPPLY_SUMMARY_STATES) {
    const entry = supplyLegendEntry(legendId);
    assert(entry.label.trim().length > 0, `${legendId} has a label the summary can use`);
    assert(totalsKey in totals, `${totalsKey} is a real count, not a name nothing produces`);
  }
  for (const id of SUPPLY_ALARMING_STATES) {
    assert(
      SUPPLY_SUMMARY_STATES.some((s) => s.legendId === id),
      `${id} is alarming and is actually counted`,
    );
  }
  // The one to act on leads, because it is the only one of these that asks for
  // an action. Its position is the summary line's only ranking.
  eq(
    SUPPLY_SUMMARY_STATES[0]?.legendId,
    "nobody-available",
    "the state worth acting on leads the summary",
  );
  assert(
    SUPPLY_ALARMING_STATES.includes("nobody-available") &&
      !SUPPLY_ALARMING_STATES.includes("none"),
    "nothing booked is every pool today and is not painted as a fault",
  );

  // The lookup REFUSES an id it does not hold rather than returning a default,
  // because a default is indistinguishable from a deliberate choice (L113) and
  // the caller is a summary chip that would silently count under a blank name.
  let threw = false;
  try {
    supplyLegendEntry("not-a-state" as SupplyLegendId);
  } catch (err) {
    threw = err instanceof Error && err.message.includes("not-a-state");
  }
  assert(threw, "an unknown state throws by name rather than resolving to a default");
}

// A shut day is its own answer, and it is not six zeros (L10).
{
  function closedRow(over: Partial<BucketSupplyRow> = {}): BucketSupplyRow {
    return {
      code: "120",
      name: "n",
      poolKey: `pool-${over.code ?? "120"}`,
      poolLabel: null,
      depth: 4,
      effectiveDepth: 3,
      cacheState: "measured",
      computedAtMs: NOW,
      freshness: "fresh",
      cells: [{ kind: "closed" }],
      ...over,
    };
  }
  assert(dayIsClosed([closedRow(), closedRow({ code: "110" })], 0), "a day every pool is shut on");
  assert(
    !dayIsClosed([closedRow(), closedRow({ code: "110", cells: [{ kind: "nobody-available" }] })], 0),
    "one pool with a real state means the day was not shut",
  );
  // Judged from the CELLS, never from the counts being zero: an empty report
  // satisfies every count too, and means something else entirely.
  assert(!dayIsClosed([], 0), "no rows at all is not a closed day");
  const totals = supplyTotals(supplyPoolGroups([closedRow()], NOW), 0);
  eq(
    totals.measured + totals.unmeasured + totals.nobodyAvailable,
    0,
    "a shut day counts as nothing at all, which is why it needs its own answer",
  );
}

// ---------------------------------------------------------------------------
// One fact per cell: the two agent counts are two columns now.
// ---------------------------------------------------------------------------
{
  eq(agentCountLabel(84), "84", "a count reads as itself");
  eq(agentCountLabel(0), "0", "zero available is a real measurement, and is stated");
  // Never zero: an unreadable roster is not a report that nobody can take these.
  eq(agentCountLabel(null), "Unknown", "an unreadable roster is unknown, never zero agents");
}

// ---------------------------------------------------------------------------
// The instant the page renders ages against comes from the LOADER's clock.
// ---------------------------------------------------------------------------
{
  const report = bucketSupplyReport({
    hours: WEEK,
    horizonDays: 4,
    nowMs: NOW,
    buckets: [{ code: "120", name: "Low" }],
    depthByCode: new Map([["120", { depth: 4, effectiveDepth: 3, poolKey: "pool-120", poolLabel: "Low" }]]),
    cacheRows: [cachedRow("120", slotsFrom1320(9), STALE_STAMP)],
    bookedByCodeAndDate: new Map(),
  });
  if (!report.measurable) {
    fail("the report is measurable");
  } else {
    // Two readings of one measurement: the grade the loader assigned and the age
    // the page prints have to come from the same instant, or a row can be judged
    // fresh and rendered as an hour old (L134).
    eq(report.nowMs, NOW, "the report carries the instant it judged freshness against");
    const row = report.rows[0];
    assert(row !== undefined, "the fixture produced a row");
    if (row) {
      eq(row.freshness, "stale", "the fixture's stamp is past the alarm");
      eq(
        computedAtLabel(row.freshness, row.computedAtMs, report.nowMs).label,
        freshnessLabel("stale").label,
        "the page's reading agrees with the loader's, because they share one clock",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// What a manager's row is called (2026-10-02): the pool in words, else the
// bucket's own name, and never the code by any route.
// ---------------------------------------------------------------------------
{
  eq(poolRowName({ code: "120", name: "Low | Beyond | Legal", poolLabel: "Low with Beyond" }), "Low with Beyond", "a pool in the matrix is named in words");
  eq(poolRowName({ code: "777", name: "Spanish speakers", poolLabel: null }), "Spanish speakers", "a hand made pool falls back to the bucket's name");
  // The loader names a cache-only row by its code when the bucket list is
  // unreadable, so a name equal to the code is not a name.
  const unnamed = poolRowName({ code: "777", name: "777", poolLabel: null });
  assert(!/777/.test(unnamed), `a name that is only the code is never shown (got ${unnamed})`);
  assert(unnamed.trim().length > 0, "and the row still says something");
  assert(!/777/.test(poolRowName({ code: "777", name: "  ", poolLabel: null })), "nor is a blank name replaced by the code");
}

// ---------------------------------------------------------------------------
// An empty pool whose leads are carried elsewhere is NOT "nobody available"
// (2026-10-02). It is its own state, unalarming, in the same vocabulary, and the
// row says where the leads go.
// ---------------------------------------------------------------------------
{
  const entry = supplyLegendEntry("overflows");
  eq(entry.label, "Overflows", "the state has its own name in the key");
  assert(!SUPPLY_ALARMING_STATES.includes("overflows"), "and it is not one of the alarming states");
  assert(
    SUPPLY_SUMMARY_STATES.some((s) => s.legendId === "overflows" && s.totalsKey === "overflows"),
    "the summary counts it on its own chip, never under nobody available",
  );
  const overflow = { kind: "overflows" as const, cover: "overflow" as const, toPool: "Low with Achieve" };
  const fallback = { kind: "overflows" as const, cover: "fallback" as const, toPool: null };
  const title = supplyCellTitle(overflow, "Low with Beyond", "Tuesday, August 4");
  assert(title.includes("Low with Achieve"), `the cell sentence names where the leads go (got ${title})`);
  assert(!/act on/i.test(title), "and does not ask anybody to act");
  assert(/fallback agent/.test(supplyCellTitle(fallback, "Low", "Tuesday, August 4")), "a fallback cover names the fallback agent");

  eq(overflowNote([{ kind: "closed" }, overflow, overflow]), "Leads go to Low with Achieve", "the row names the target once");
  eq(overflowNote([fallback]), "Leads go to the fallback agent", "or the fallback agent");
  eq(
    overflowNote([overflow, fallback]),
    "Leads go to Low with Achieve or the fallback agent",
    "two different covers on different days are both named",
  );
  eq(
    overflowNote([{ kind: "overflows", cover: "overflow", toPool: null }]),
    "Leads go to another pool",
    "a target outside the routing matrix is never named by a code",
  );
  eq(overflowNote([{ kind: "nobody-available" }, { kind: "closed" }]), null, "a row nothing catches has no note");
}

// What tells two manager rows of one pool apart without a code.
{
  eq(poolRowDetail({ code: "111", name: "Low | Both | Legal" }), "Low | Both | Legal", "the stored name, when it is a name");
  eq(poolRowDetail({ code: "111", name: "111" }), "Low | Both | Legal", "a name that is only the code is spelled out from the code's digits");
  eq(poolRowDetail({ code: "777", name: "777" }), null, "and a code the matrix cannot spell has nothing to show rather than the code");
  eq(poolRowName({ code: "111", name: "111", poolLabel: null }), "Low | Both | Legal", "a manager's row name spells an XBC code out before giving up");
}

finish();
