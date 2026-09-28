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
  formatBookedSolidAlert,
  isBroadRecomputeFailure,
  availabilityAlertVerdict,
  formatAvailabilityRecovery,
  reportAvailabilityHealth,
  DATA_ANOMALY_ALERT_KEY,
  type WorkingRule,
  type AgentShift,
  type DeadEndCause,
} from "../src/lib/monitor/availability-health.ts";
import { tierLadder } from "../src/lib/routing/tiers.ts";
import { assert, finish } from "./lib/harness.ts";

// Em dash, en dash, or a spaced hyphen used as punctuation. Built from escapes so
// this file never contains the literal characters the copy rule forbids.
const DASHES = new RegExp("[\\u2013\\u2014]|\\s-\\s");

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
  assert(isWorkingNow(Date.UTC(2026, 5, 23, 18, 0, 0), "America/New_York", NINE_TO_FIVE), "ET agent at 14:00 local -> working");
  // Tue 18:00 EDT (after 17:00) -> not working.
  assert(!isWorkingNow(Date.UTC(2026, 5, 23, 22, 0, 0), "America/New_York", NINE_TO_FIVE), "ET agent at 18:00 local -> off shift");
  // Winter Mon 09:30 EST -> working (proves DST/EST offset, not a fixed UTC slice).
  assert(isWorkingNow(Date.UTC(2026, 0, 5, 14, 30, 0), "America/New_York", NINE_TO_FIVE), "ET agent 09:30 EST winter -> working (DST aware)");
  // PT agent at 23:30 UTC = 16:30 PDT (working). The SAME instant is 19:30 ET (off) -> proves the agent's OWN tz is used.
  assert(isWorkingNow(Date.UTC(2026, 5, 23, 23, 30, 0), "America/Los_Angeles", NINE_TO_FIVE), "PT agent at 16:30 local -> working (uses agent tz, not ET)");
  // Saturday -> off (weekday gate).
  assert(!isWorkingNow(Date.UTC(2026, 5, 20, 18, 0, 0), "America/New_York", NINE_TO_FIVE), "weekend -> off shift");
  // No rules -> never on shift (matches how availability treats a scheduleless agent).
  assert(!isWorkingNow(NOW, "America/New_York", []), "agent with no rules -> off shift");
}

// --- anyOnShift ---
{
  const onMidday = Date.UTC(2026, 5, 23, 18, 0, 0); // Tue 14:00 ET
  // The org open around the clock, so these stay about the AGENTS' shifts.
  const ORG_OPEN: AgentShift = {
    timezone: "America/New_York",
    rules: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start_minute: 0, end_minute: 1440 })),
  };
  assert(
    anyOnShift(onMidday, [
      { timezone: "America/New_York", rules: [] }, // off (no rules)
      { timezone: "America/New_York", rules: NINE_TO_FIVE }, // on
    ], ORG_OPEN),
    "true when at least one eligible agent is on shift",
  );
  assert(
    !anyOnShift(onMidday, [
      { timezone: "America/New_York", rules: [] },
      { timezone: "America/New_York", rules: [{ weekday: 6, start_minute: 540, end_minute: 1020 }] }, // Sat only
    ], ORG_OPEN),
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
  assert(out.length === 1 && out[0] === "411", "flags only on-shift + eligible>0 + fresh + zero-slot buckets");
  assert(!out.includes("416"), "ignores buckets with no eligible agent on shift (legitimately closed)");
  assert(!out.includes("413"), "ignores zero-eligible buckets (that is #327's signal)");
  assert(!out.includes("414"), "ignores STALE rows (the recompute lane's concern)");
  assert(!out.includes("415"), "ignores never-computed (null) rows");
  assert(!out.includes("412"), "ignores buckets that have slots");
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
  const bucketInfo = new Map<string, { slotCount: number; slotCountWithoutLow?: number | null; isTest: boolean }>([
    ["520", { slotCount: 0, isTest: false }],
    ["420", { slotCount: 50, slotCountWithoutLow: 50, isTest: false }], // covers 520
    ["320", { slotCount: 64, isTest: false }],
    ["521", { slotCount: 0, isTest: false }],
    ["421", { slotCount: 0, isTest: false }],
    ["321", { slotCount: 0, isTest: false }],
    ["221", { slotCount: 0, isTest: false }],
    ["121", { slotCount: 0, isTest: false }],
  ]);
  const out = classifyEmptyBuckets(rows, { nowMs: NOW, freshWindowMs: FRESH, ladder, bucketInfo });
  assert(out.page.length === 1 && out.page[0] === "521", "pages only the bucket whose entire ladder is dry");
  assert(
    out.covered.length === 1 && out.covered[0].code === "520" && out.covered[0].via === "420",
    "reports the fallback-covered bucket with the first lower rung that has slots",
  );
  assert(!out.page.includes("530"), "a bucket nobody is on shift for is not classified at all (not failing)");
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
  assert(out.page.length === 1 && out.page[0] === "540", "a TEST rung with slots does not count as coverage (pages)");
  assert(out.covered.length === 0, "no fallback-covered entry when the only rung with slots is a test bucket");
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
  assert(out.page.length === 1 && out.covered.length === 0, "missing lower-rung rows count as no coverage");
}

// --- #2842: below a top tier lead's own tier, only advisors without Low count ---
//
// The booker judges those rungs on the times an advisor WITHOUT Low is free, so the
// monitor must too, or it reports an Ultra lead as covered by a Medium pool made
// entirely of Low carriers while the booker offers that lead nothing.
{
  const rows = [
    { code: "520", eligibleCount: 3, slotCount: 0, computedAtMs: NOW - 1000, onShiftNow: true },
    { code: "320", eligibleCount: 3, slotCount: 0, computedAtMs: NOW - 1000, onShiftNow: true },
  ];
  const bucketInfo = new Map<string, { slotCount: number; slotCountWithoutLow?: number | null; isTest: boolean }>([
    ["520", { slotCount: 0, isTest: false }],
    ["420", { slotCount: 50, slotCountWithoutLow: 0, isTest: false }], // only Low carriers free
    ["320", { slotCount: 0, slotCountWithoutLow: null, isTest: false }], // unmeasured second list
    ["220", { slotCount: 9, slotCountWithoutLow: 4, isTest: false }],
  ]);
  const out = classifyEmptyBuckets(rows, { nowMs: NOW, freshWindowMs: FRESH, ladder: tierLadder, bucketInfo });
  const ultra = out.covered.find((c) => c.code === "520");
  assert(ultra?.via === "220", `an Ultra lead is covered only where an advisor without Low is free (got ${ultra?.via})`);
  // The same pools judged for a HIGH lead: its cascade keeps Low carriers, so
  // 220's full count covers it, the direction that proves the rule is per lead.
  const high = out.covered.find((c) => c.code === "320");
  assert(high?.via === "220", `a High lead's cascade counts Low carriers (got ${high?.via})`);
}
{
  // Every lower rung free only for Low carriers: an Ultra dead end, not coverage.
  const rows = [{ code: "511", eligibleCount: 3, slotCount: 0, computedAtMs: NOW - 1000, onShiftNow: true }];
  const bucketInfo = new Map<string, { slotCount: number; slotCountWithoutLow?: number | null; isTest: boolean }>([
    ["511", { slotCount: 0, isTest: false }],
    ["411", { slotCount: 20, slotCountWithoutLow: 0, isTest: false }],
    ["311", { slotCount: 20, isTest: false }], // a row from before the second list existed
    ["211", { slotCount: 20, slotCountWithoutLow: 0, isTest: false }],
    ["111", { slotCount: 99, slotCountWithoutLow: 99, isTest: false }], // below the floor
  ]);
  const out = classifyEmptyBuckets(rows, { nowMs: NOW, freshWindowMs: FRESH, ladder: tierLadder, bucketInfo });
  assert(out.page.includes("511"), "an Ultra lead only Low carriers could serve is a dead end, and pages");
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
  assert(notice.includes("520") && notice.includes("420"), "notice names each empty bucket and the covering rung");
  assert(/fallback|cover/i.test(notice), "notice makes clear the fallback is covering (not a customer dead-end)");
  // #585: the raw '520 via 420' is enriched so the on-call reader needs no lookup.
  assert(notice.includes("Ultra High | Beyond | Non-Legal"), "notice spells out the human tier name");
  assert(/sole agent|1 agent|one agent/i.test(notice), "notice flags a one-deep covering tier as thin");
  assert(/booked|full/i.test(notice), "notice states the likely cause (calendars full)");
  assert(notice.includes("3 agents"), "notice reports the empty tier's agent depth");
  assert(!/[\u2013\u2014]/.test(notice), "notice uses no em/en dashes (copy rule)");
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
  assert(cause.bookedSolid.join() === "FULL", "recompute 0 -> bookedSolid");
  assert(cause.dataAnomaly.join() === "ANOM", "recompute >0 -> dataAnomaly");
  assert(cause.unverified.slice().sort().join() === "MISS,NULL", "null/absent -> unverified");
}

// --- formatDataAnomalyAlert: names anomaly + unverified with runbook, no dashes ---
{
  const msg = formatDataAnomalyAlert({ bookedSolid: [], dataAnomaly: ["ANOM"], unverified: ["NULL"] });
  assert(msg.includes("ANOM") && msg.includes("NULL"), "anomaly alert names both groups");
  assert(/sync|precompute/i.test(msg), "anomaly alert points at the sync/precompute pipeline");
  assert(!DASHES.test(msg), "anomaly alert has no dashes");
  // No auto-heal note when nothing was healed (default arg).
  assert(!/auto-recompute/i.test(msg), "no self-heal note when nothing healed");
}

// --- #573: when buckets were auto-healed, the page says the impact was recovered
// but the root cause still needs a fix (so it stays urgent, not resolved). ---
{
  const cause = { bookedSolid: [], dataAnomaly: ["ANOM", "ANOM2"], unverified: [] };
  const msg = formatDataAnomalyAlert(cause, ["ANOM"]);
  assert(/auto-recompute/i.test(msg), "healed anomaly alert notes the auto-recompute");
  assert(msg.includes("ANOM"), "healed anomaly alert names the healed bucket");
  assert(/mask|root cause|find why|stale/i.test(msg), "healed alert still flags the unresolved root cause");
  assert(!DASHES.test(msg), "healed anomaly alert has no dashes");
}

// --- #572: a mostly-unverified run is ONE upstream outage, not N bucket faults ---
// An outage is exactly when on-call needs a single clear signal. Listing 8 arbitrary
// codes out of 54 invites chasing individual buckets instead of the upstream cause.
{
  const many = Array.from({ length: 54 }, (_, i) => `${100 + i}`);
  const solid = ["S1", "S2", "S3", "S4", "S5", "S6"];
  const cause = { bookedSolid: solid, dataAnomaly: [], unverified: many };
  assert(isBroadRecomputeFailure(cause), "54 of 60 unverified reads as a broad failure");

  const msg = formatDataAnomalyAlert(cause);
  assert(/broadly/i.test(msg), "broad outage alert says recompute is failing broadly");
  assert(/upstream|outage/i.test(msg), "broad outage alert names the likely upstream cause");
  assert(msg.includes("54") && msg.includes("60"), "broad outage alert gives the 54 of 60 ratio");
  // The whole point: do not enumerate a arbitrary slice of the failing codes.
  assert(!msg.includes("100, 101"), "broad outage alert does not list individual codes");
  assert(!DASHES.test(msg), "broad outage alert has no dashes");
}

// A single unverified bucket is a real, investigable bucket, so keep naming it.
{
  const cause = { bookedSolid: ["S1", "S2"], dataAnomaly: [], unverified: ["311"] };
  assert(!isBroadRecomputeFailure(cause), "1 of 3 unverified is not a broad failure");
  const msg = formatDataAnomalyAlert(cause);
  assert(msg.includes("311"), "isolated unverified bucket is still named");
  assert(!/broadly/i.test(msg), "isolated unverified bucket does not claim an outage");
}

// A tiny run that happens to be 100% unverified must not cry outage: with only a
// few dead-end buckets there is no evidence the failure is broad.
{
  const cause = { bookedSolid: [], dataAnomaly: [], unverified: ["A", "B", "C"] };
  assert(!isBroadRecomputeFailure(cause), "3 unverified with no comparison set is not broad");
  assert(!/broadly/i.test(formatDataAnomalyAlert(cause)), "tiny all-unverified run stays specific");
}

// A broad recompute failure alongside a genuine data anomaly must report BOTH:
// the anomaly is separately actionable and must not be swallowed by the outage line.
{
  const many = Array.from({ length: 20 }, (_, i) => `U${i}`);
  const msg = formatDataAnomalyAlert({ bookedSolid: [], dataAnomaly: ["ANOM"], unverified: many });
  assert(msg.includes("ANOM"), "data anomaly is still named during a broad outage");
  assert(/broadly/i.test(msg), "broad unverified group still collapses to the outage line");
}

// --- formatBookedSolidAlert: capacity wording, no dashes ---
{
  const msg = formatBookedSolidAlert(["FULL1", "FULL2"]);
  assert(msg.includes("FULL1") && msg.includes("FULL2"), "booked-solid notice names the tiers");
  assert(/capacity|booked solid|staffing/i.test(msg), "booked-solid notice reads as a capacity heads up");
  assert(!DASHES.test(msg), "booked-solid notice has no dashes");
}

// --- #1134: when may the data-anomaly page be cleared? -----------------------
//
// Three outcomes, not two. The trap this issue exists for is collapsing "we found
// nothing wrong" and "we did not finish looking" into one healthy verdict: the
// monitor's bucket scan is budget-bounded, so a slow tick can stop early and
// report an empty anomaly list having examined a fraction of the buckets.
{
  const none: DeadEndCause = { bookedSolid: [], dataAnomaly: [], unverified: [] };
  assert(
    availabilityAlertVerdict(none, false) === "healthy",
    "a complete scan that found no anomalies is health",
  );
  assert(
    availabilityAlertVerdict(none, true) === "unknown",
    "a TRUNCATED scan that found no anomalies is not health: it did not look everywhere",
  );
  assert(
    availabilityAlertVerdict({ ...none, dataAnomaly: ["411"] }, false) === "alerting",
    "an anomaly alerts",
  );
  assert(
    availabilityAlertVerdict({ ...none, unverified: ["411"] }, false) === "alerting",
    "a bucket whose cause could not be verified alerts, rather than passing as healthy",
  );
  // A real finding still alerts even from a partial scan: not finishing does not
  // make what we DID find any less true.
  assert(
    availabilityAlertVerdict({ ...none, dataAnomaly: ["411"] }, true) === "alerting",
    "an anomaly found during a truncated scan still alerts",
  );
  // Booked solid is a capacity fact, deliberately informational. It must not hold
  // the anomaly page open, or a genuinely full calendar would suppress the
  // all-clear indefinitely.
  assert(
    availabilityAlertVerdict({ ...none, bookedSolid: ["411", "412"] }, false) === "healthy",
    "booked-solid buckets do not block the anomaly all-clear",
  );
}

{
  const msg = formatAvailabilityRecovery();
  assert(/recover|cleared|showing times|back/i.test(msg), "the all-clear says the condition cleared");
  assert(/no action/i.test(msg), "the all-clear tells the reader there is nothing to do");
  assert(
    !/check the precompute|calendar sync pipeline/i.test(msg),
    "the all-clear does not repeat the page's investigate-the-pipeline instruction",
  );
  assert(!DASHES.test(msg), "the all-clear has no dashes");
}

// The page-or-all-clear decision itself (#1152). The verdict function above is
// pure and was already covered; what was not is what the lane DOES with each
// verdict, and specifically that a truncated scan keeps its mouth shut. That is
// the branch a swallowed read reaches, and it was the one branch with no test.
{
  const none: DeadEndCause = { dataAnomaly: [], bookedSolid: [], unverified: [], other: [] };

  const run = async (cause: DeadEndCause, scanTruncated: boolean) => {
    const paged: string[] = [];
    const resolved: string[] = [];
    const res = await reportAvailabilityHealth({
      cause,
      scanTruncated,
      cooldownMs: 1000,
      healed: [],
      notify: async (key) => void paged.push(key),
      resolve: async (key) => {
        resolved.push(key);
        return true;
      },
    });
    return { paged, resolved, ...res };
  };

  const truncated = await run(none, true);
  assert(truncated.verdict === "unknown", "a truncated scan with no findings is unknown");
  assert(
    truncated.resolved.length === 0,
    "a truncated scan sends NO all-clear: it never looked at every bucket",
  );
  assert(truncated.paged.length === 0, "a truncated scan with no findings does not page either");

  // Controls, so the assertions above cannot be passing because nothing is ever
  // dispatched: the healthy tick really does all-clear, and a finding really pages.
  const healthy = await run(none, false);
  assert(healthy.verdict === "healthy", "a complete scan with no findings is healthy");
  assert(
    healthy.resolved[0] === DATA_ANOMALY_ALERT_KEY,
    "a complete clean scan all-clears the data-anomaly page",
  );
  assert(healthy.cleared, "the all-clear reports whether a notice actually went out");

  const alerting = await run({ ...none, dataAnomaly: ["411"] }, false);
  assert(alerting.paged[0] === DATA_ANOMALY_ALERT_KEY, "a real anomaly pages");
  assert(alerting.resolved.length === 0, "a tick that pages does not also all-clear");

  // Failure path: monitoring must never take down the lane it watches.
  const thrower = await reportAvailabilityHealth({
    cause: none,
    scanTruncated: false,
    cooldownMs: 1000,
    healed: [],
    notify: async () => {},
    resolve: async () => {
      throw new Error("slack down");
    },
  });
  assert(
    thrower.cleared === false,
    "a failed recovery notice reports not-cleared instead of throwing into the lane",
  );
}

// --- #1296: the org's own hours are part of "should this be showing times" --------
//
// `failingBuckets` pages on "an agent is working but the booker shows nothing", and
// the read path now filters cached slots to the org's hours. Those two must agree,
// or closing the org becomes indistinguishable from a wedged cache: the count drops
// to zero for a real reason, an agent is still on shift, and the probe pages about
// a bucket that is behaving exactly as configured.
{
  const AGENT_ALL_WEEK: AgentShift[] = [
    { timezone: "America/New_York", rules: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start_minute: 0, end_minute: 1440 })) },
  ];
  // Monday 2026-06-08, 21:00 New York. The agent is on shift; the org shut at 20:00.
  const nowMs = Date.parse("2026-06-09T01:00:00.000Z");
  const orgOpen8to8: AgentShift = {
    timezone: "America/New_York",
    rules: [{ weekday: 1, start_minute: 8 * 60, end_minute: 20 * 60 }],
  };
  const orgAllDay: AgentShift = {
    timezone: "America/New_York",
    rules: [{ weekday: 1, start_minute: 0, end_minute: 1440 }],
  };

  assert(
    anyOnShift(nowMs, AGENT_ALL_WEEK, orgOpen8to8) === false,
    "an agent working past the org's close does not count as on shift: the org is shut",
  );
  assert(
    anyOnShift(nowMs, AGENT_ALL_WEEK, orgAllDay) === true,
    "the same agent at the same instant IS on shift once the org is open then",
  );
  assert(
    anyOnShift(nowMs, [], orgAllDay) === false,
    "an open org with nobody rostered is still not on shift",
  );
}

// #1412: the copy agrees with the count. Both forms render fine through a
// substring assertion, which is exactly why they have to be pinned: "3 tiers
// because ITS agents" and "1 tier on THOSE funnels" are what a reader actually
// notices, and only reading it catches them.
{
  const many = formatBookedSolidAlert(["204", "311", "417"]);
  assert(many.includes("3 tiers are"), "the plural subject agrees");
  assert(many.includes("their agents"), "and so does the possessive");
  assert(many.includes("those funnels"), "and the funnels");
  assert(!many.includes("its agents"), "no singular possessive on a plural subject");

  const one = formatBookedSolidAlert(["204"]);
  assert(one.includes("1 tier is"), "the singular subject agrees");
  assert(one.includes("its agents"), "and so does the possessive");
  assert(one.includes("that funnel"), "and the funnel");
  assert(!one.includes("those funnels"), "no plural funnels on a single tier");

  // The page has to say plainly, in its first line, that nothing is broken. A
  // reader woken by it will otherwise hunt a fault that is not there (L106).
  assert(/nothing is broken/i.test(one), "the page says nothing is broken");
  assert(/coverage/i.test(one), "and names the action, which is staffing");
  assert(one.includes("204"), "and names the tier, so it can be acted on");
}

finish();
