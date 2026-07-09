// Pure logic for the availability-health probe (#371): which buckets SHOULD show
// booking times but don't, and the per-bucket "is any eligible agent on shift in
// their own timezone right now" gate (DST-aware) that keeps the probe from crying
// wolf when a bucket is legitimately closed. Run:
//   node --experimental-strip-types scripts/test-monitor-availability-health.ts
import {
  isWorkingNow,
  anyOnShift,
  failingBuckets,
  classifyEmptyBuckets,
  formatFallbackCoveredNotice,
  classifyDeadEndCause,
  formatDataAnomalyAlert,
  formatBookedSolidNotice,
  type WorkingRule,
} from "../src/lib/monitor/availability-health.ts";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error("FAIL:", msg);
    failed++;
  } else {
    console.log("ok:", msg);
  }
};

const NOW = Date.UTC(2026, 5, 23, 18, 0, 0); // 2026-06-23 14:00 ET (fresh ref)
const FRESH = 6 * 60_000;
const NINE_TO_FIVE: WorkingRule[] = [
  { weekday: 1, start_minute: 540, end_minute: 1020 },
  { weekday: 2, start_minute: 540, end_minute: 1020 },
  { weekday: 3, start_minute: 540, end_minute: 1020 },
  { weekday: 4, start_minute: 540, end_minute: 1020 },
  { weekday: 5, start_minute: 540, end_minute: 1020 },
];

// --- isWorkingNow (per-agent, timezone + DST aware) ---
{
  // Tue 14:00 EDT (within 9-17) -> working.
  ok(isWorkingNow(Date.UTC(2026, 5, 23, 18, 0, 0), "America/New_York", NINE_TO_FIVE), "ET agent at 14:00 local -> working");
  // Tue 18:00 EDT (after 17:00) -> not working.
  ok(!isWorkingNow(Date.UTC(2026, 5, 23, 22, 0, 0), "America/New_York", NINE_TO_FIVE), "ET agent at 18:00 local -> off shift");
  // Winter Mon 09:30 EST -> working (proves DST/EST offset, not a fixed UTC slice).
  ok(isWorkingNow(Date.UTC(2026, 0, 5, 14, 30, 0), "America/New_York", NINE_TO_FIVE), "ET agent 09:30 EST winter -> working (DST aware)");
  // PT agent at 23:30 UTC = 16:30 PDT (working). The SAME instant is 19:30 ET (off) -> proves the agent's OWN tz is used.
  ok(isWorkingNow(Date.UTC(2026, 5, 23, 23, 30, 0), "America/Los_Angeles", NINE_TO_FIVE), "PT agent at 16:30 local -> working (uses agent tz, not ET)");
  // Saturday -> off (weekday gate).
  ok(!isWorkingNow(Date.UTC(2026, 5, 20, 18, 0, 0), "America/New_York", NINE_TO_FIVE), "weekend -> off shift");
  // No rules -> never on shift (matches how availability treats a scheduleless agent).
  ok(!isWorkingNow(NOW, "America/New_York", []), "agent with no rules -> off shift");
}

// --- anyOnShift ---
{
  const onMidday = Date.UTC(2026, 5, 23, 18, 0, 0); // Tue 14:00 ET
  ok(
    anyOnShift(onMidday, [
      { timezone: "America/New_York", rules: [] }, // off (no rules)
      { timezone: "America/New_York", rules: NINE_TO_FIVE }, // on
    ]),
    "true when at least one eligible agent is on shift",
  );
  ok(
    !anyOnShift(onMidday, [
      { timezone: "America/New_York", rules: [] },
      { timezone: "America/New_York", rules: [{ weekday: 6, start_minute: 540, end_minute: 1020 }] }, // Sat only
    ]),
    "false when no eligible agent is on shift",
  );
}

// --- failingBuckets ---
{
  const rows = [
    { code: "411", eligibleCount: 5, slotCount: 0, computedAtMs: NOW - 1000, onShiftNow: true }, // broken-empty
    { code: "416", eligibleCount: 5, slotCount: 0, computedAtMs: NOW - 1000, onShiftNow: false }, // no one on shift (legit)
    { code: "412", eligibleCount: 5, slotCount: 3, computedAtMs: NOW - 1000, onShiftNow: true }, // has slots
    { code: "413", eligibleCount: 0, slotCount: 0, computedAtMs: NOW - 1000, onShiftNow: true }, // no agents (#327's job)
    { code: "414", eligibleCount: 5, slotCount: 0, computedAtMs: NOW - 9 * 60_000, onShiftNow: true }, // stale
    { code: "415", eligibleCount: 5, slotCount: 0, computedAtMs: null, onShiftNow: true }, // never computed
  ];
  const out = failingBuckets(rows, { nowMs: NOW, freshWindowMs: FRESH });
  ok(out.length === 1 && out[0] === "411", "flags only on-shift + eligible>0 + fresh + zero-slot buckets");
  ok(!out.includes("416"), "ignores buckets with no eligible agent on shift (legitimately closed)");
  ok(!out.includes("413"), "ignores zero-eligible buckets (that is #327's signal)");
  ok(!out.includes("414"), "ignores STALE rows (the recompute lane's concern)");
  ok(!out.includes("415"), "ignores never-computed (null) rows");
  ok(!out.includes("412"), "ignores buckets that have slots");
}

// --- classifyEmptyBuckets (#567): fallback-aware split of empty buckets ---
// A test ladder mirroring the real XBC tier ladder: 5xx -> 4xx -> ... -> 1xx.
const ladder = (code: string) => {
  const adv = Number(code[0]);
  const rest = code.slice(1);
  const out: string[] = [];
  for (let t = adv; t >= 1; t--) out.push(`${t}${rest}`);
  return out;
};
{
  // 520 is on-shift/eligible/fresh but empty; the lower rung 420 has slots -> covered.
  // 521 is empty AND its whole ladder (421,321,221,121) is dry -> page (real dead-end).
  const rows = [
    { code: "520", eligibleCount: 3, slotCount: 0, computedAtMs: NOW - 1000, onShiftNow: true },
    { code: "521", eligibleCount: 2, slotCount: 0, computedAtMs: NOW - 1000, onShiftNow: true },
    { code: "530", eligibleCount: 2, slotCount: 0, computedAtMs: NOW - 1000, onShiftNow: false }, // closed, not failing
  ];
  const bucketInfo = new Map<string, { slotCount: number; isTest: boolean }>([
    ["520", { slotCount: 0, isTest: false }],
    ["420", { slotCount: 50, isTest: false }], // covers 520
    ["320", { slotCount: 64, isTest: false }],
    ["521", { slotCount: 0, isTest: false }],
    ["421", { slotCount: 0, isTest: false }],
    ["321", { slotCount: 0, isTest: false }],
    ["221", { slotCount: 0, isTest: false }],
    ["121", { slotCount: 0, isTest: false }],
  ]);
  const out = classifyEmptyBuckets(rows, { nowMs: NOW, freshWindowMs: FRESH, ladder, bucketInfo });
  ok(out.page.length === 1 && out.page[0] === "521", "pages only the bucket whose entire ladder is dry");
  ok(
    out.covered.length === 1 && out.covered[0].code === "520" && out.covered[0].via === "420",
    "reports the fallback-covered bucket with the first lower rung that has slots",
  );
  ok(!out.page.includes("530"), "a bucket nobody is on shift for is not classified at all (not failing)");
}
{
  // The tier-fallback cascade must skip synthetic test buckets, exactly like the
  // booker's getBucketSlotsWithFallback -> a test rung with slots does NOT count as coverage.
  const rows = [
    { code: "540", eligibleCount: 1, slotCount: 0, computedAtMs: NOW - 1000, onShiftNow: true },
  ];
  const bucketInfo = new Map<string, { slotCount: number; isTest: boolean }>([
    ["540", { slotCount: 0, isTest: false }],
    ["440", { slotCount: 99, isTest: true }], // a test bucket with slots -> must be ignored
    ["340", { slotCount: 0, isTest: false }],
    ["240", { slotCount: 0, isTest: false }],
    ["140", { slotCount: 0, isTest: false }],
  ]);
  const out = classifyEmptyBuckets(rows, { nowMs: NOW, freshWindowMs: FRESH, ladder, bucketInfo });
  ok(out.page.length === 1 && out.page[0] === "540", "a TEST rung with slots does not count as coverage (pages)");
  ok(out.covered.length === 0, "no fallback-covered entry when the only rung with slots is a test bucket");
}
{
  // A lower rung that is missing from bucketInfo entirely is treated as no-coverage.
  const rows = [
    { code: "510", eligibleCount: 1, slotCount: 0, computedAtMs: NOW - 1000, onShiftNow: true },
  ];
  const out = classifyEmptyBuckets(rows, {
    nowMs: NOW,
    freshWindowMs: FRESH,
    ladder,
    bucketInfo: new Map([["510", { slotCount: 0, isTest: false }]]),
  });
  ok(out.page.length === 1 && out.covered.length === 0, "missing lower-rung rows count as no coverage");
}

// --- formatFallbackCoveredNotice (#567/#585): the low-priority info signal,
//     now self-explaining (human tier name + covering depth + likely cause) ---
{
  const notice = formatFallbackCoveredNotice([
    {
      code: "520",
      via: "420",
      tierName: "Ultra High | Beyond | Non-Legal",
      viaTierName: "Very High | Beyond | Non-Legal",
      emptyDepth: 1,
      coverDepth: 1,
    },
    {
      code: "530",
      via: "330",
      tierName: "Ultra High | Achieve | Non-Legal",
      viaTierName: "High | Achieve | Non-Legal",
      emptyDepth: 3,
      coverDepth: 4,
    },
  ]);
  ok(notice.includes("520") && notice.includes("420"), "notice names each empty bucket and the covering rung");
  ok(/fallback|cover/i.test(notice), "notice makes clear the fallback is covering (not a customer dead-end)");
  // #585: the raw '520 via 420' is enriched so the on-call reader needs no lookup.
  ok(notice.includes("Ultra High | Beyond | Non-Legal"), "notice spells out the human tier name");
  ok(/sole agent|1 agent|one agent/i.test(notice), "notice flags a one-deep covering tier as thin");
  ok(/booked|full/i.test(notice), "notice states the likely cause (calendars full)");
  ok(notice.includes("3 agents"), "notice reports the empty tier's agent depth");
  ok(!/[–—]/.test(notice), "notice uses no em/en dashes (copy rule)");
}

// --- classifyDeadEndCause: split paged buckets by live-recompute result ---
{
  const counts = new Map<string, number | null>([
    ["FULL", 0], // recompute also 0 -> booked solid
    ["ANOM", 3], // recompute > 0 -> cache disagrees with calendars
    ["NULL", null], // recompute failed -> unverified
    // "MISS" intentionally absent from the map -> unverified
  ]);
  const cause = classifyDeadEndCause(["FULL", "ANOM", "NULL", "MISS"], counts);
  ok(cause.bookedSolid.join() === "FULL", "recompute 0 -> bookedSolid");
  ok(cause.dataAnomaly.join() === "ANOM", "recompute >0 -> dataAnomaly");
  ok(cause.unverified.slice().sort().join() === "MISS,NULL", "null/absent -> unverified");
}

// --- formatDataAnomalyAlert: names anomaly + unverified with runbook, no dashes ---
{
  const msg = formatDataAnomalyAlert({ bookedSolid: [], dataAnomaly: ["ANOM"], unverified: ["NULL"] });
  ok(msg.includes("ANOM") && msg.includes("NULL"), "anomaly alert names both groups");
  ok(/sync|precompute/i.test(msg), "anomaly alert points at the sync/precompute pipeline");
  ok(!/[–—]/.test(msg) && !/ - /.test(msg), "anomaly alert has no dashes");
}

// --- formatBookedSolidNotice: capacity wording, no dashes ---
{
  const msg = formatBookedSolidNotice(["FULL1", "FULL2"]);
  ok(msg.includes("FULL1") && msg.includes("FULL2"), "booked-solid notice names the tiers");
  ok(/capacity|booked solid|staffing/i.test(msg), "booked-solid notice reads as a capacity heads up");
  ok(!/[–—]/.test(msg) && !/ - /.test(msg), "booked-solid notice has no dashes");
}

console.log(failed === 0 ? "\nALL PASSED" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
