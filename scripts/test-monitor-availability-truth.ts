// Pure logic for the availability-truth probe (#1315): are the times we are
// OFFERING actually free on the real calendars? Run:
//   node --experimental-strip-types scripts/test-monitor-availability-truth.ts
//
// The case this exists for is the leading half of the 2026-08-06 cal.com
// incident. Their diagnosis was that "the slots we fetch on the booker doesn't
// match exactly what the hosts true availability is": customers were offered
// times that were not really free, and the only thing that noticed was a
// complaint monitor. Slate reads a CACHE on the booker and only touches live
// Google at confirm time, so it carries the same exposure by design.
//
// The distinction every assertion below turns on: a slot we could not CHECK is
// not a slot we checked and found fine. Google refusing a calendar has to leave
// the sample smaller, never cleaner.
import {
  sampleSlotStarts,
  classifySlotVerdict,
  summarizeSample,
  judgeAvailabilityTruth,
  formatAvailabilityDriftAlert,
  formatAvailabilityDriftAllClear,
  formatAvailabilityDriftAggregateAlert,
  formatAvailabilityDriftAggregateAllClear,
  planDriftAlert,
  runAvailabilityTruthCheck,
  AVAILABILITY_TRUTH_ALERT_KEY,
  AGGREGATE_DRIFT_CODE,
  AGGREGATE_DRIFT_THRESHOLD,
  type SlotVerdict,
  type TruthThresholds,
  type TruthResult,
} from "../src/lib/monitor/availability-truth.ts";
import { assert, eq, finish } from "./lib/harness.ts";

/** Em/en dash detector built from escapes: writing the characters themselves
 *  would trip the repo's own copy lint on this very file. */
const DASHES = new RegExp("[\\u2013\\u2014]");

const MIN = 60_000;
const NOW = Date.UTC(2026, 7, 11, 14, 0, 0);
const iso = (offsetMin: number) => new Date(NOW + offsetMin * MIN).toISOString();

const THRESHOLDS: TruthThresholds = {
  sampleSize: 5,
  nearCount: 2,
  leadMs: 10 * MIN,
  minVerified: 3,
  driftPct: 40,
};
/** Spec-only view, so a test can vary the sample shape without a full threshold set. */
const spec = (sampleSize: number, nearCount: number, leadMs = THRESHOLDS.leadMs) => ({
  sampleSize,
  nearCount,
  leadMs,
});

// --- sampleSlotStarts: near slots AND the rest of the horizon (#1376) ---
//
// The soonest times are where a stale cache costs a customer first, so they stay
// weighted. But Slate advertises several DAYS, and a sample that only ever reads
// the head of the list leaves everything past the next hour unchecked while the
// probe reports on "availability". Both halves are asserted below, because a
// sample that quietly slid back to head-only would still pass every near-slot
// assertion on its own.
{
  const starts = [iso(120), iso(30), iso(600), iso(45), iso(20)];
  const picked = sampleSlotStarts(starts, NOW, spec(3, 3));
  eq(picked, [iso(20), iso(30), iso(45)], "an all-near sample is still the soonest slots, in time order");
}
{
  // A slot inside the lead time is about to be checked by verify-on-book anyway,
  // and a booking landing on it mid-probe would read as drift. Skip it.
  const starts = [iso(1), iso(5), iso(30), iso(60)];
  const picked = sampleSlotStarts(starts, NOW, spec(5, 2));
  eq(picked, [iso(30), iso(60)], "skips slots closer than the lead time");
}
{
  eq(sampleSlotStarts([iso(-60), iso(-5)], NOW, spec(5, 2, 0)), [], "a payload of only past slots samples nothing");
  eq(sampleSlotStarts([], NOW, spec(5, 2, 0)), [], "an empty payload samples nothing");
}
{
  const starts = [iso(30), "not-a-timestamp", iso(60)];
  const picked = sampleSlotStarts(starts, NOW, spec(5, 2));
  eq(picked, [iso(30), iso(60)], "an unreadable start is dropped, never sorted as epoch 0 or NaN");
}
{
  // The headline case: four days of offered times, the shape production has.
  // A head-only sample reads the first 5 of 96 and calls it availability.
  const day = 24 * 60;
  const starts: string[] = [];
  for (let d = 0; d < 4; d += 1) for (let h = 0; h < 24; h += 1) starts.push(iso(d * day + h * 60));
  const picked = sampleSlotStarts(starts, NOW, spec(5, 2));
  eq(picked.length, 5, "the sample size is the COST ceiling and is not exceeded by spreading");
  eq(picked[0], iso(60), "the two soonest bookable slots lead the sample");
  eq(picked[1], iso(120), "and the second");
  const lastMs = Date.parse(picked[picked.length - 1]);
  assert(
    lastMs > NOW + 2 * day * MIN,
    "the sample reaches past the halfway point of the horizon, not just the next hour",
  );
  const spanMin = (lastMs - Date.parse(picked[0])) / MIN;
  assert(spanMin > 2 * day, `the sample spans days, not minutes (spanned ${spanMin} minutes)`);
  eq(new Set(picked).size, 5, "and never checks the same slot twice");
  eq([...picked].sort(), [...picked].sort(), "sanity: comparable");
  const ordered = [...picked].every((v, i, a) => i === 0 || Date.parse(a[i - 1]) < Date.parse(v));
  assert(ordered, "the sample is returned in time order");
}
{
  // Fewer offered slots than the sample size: take them all rather than
  // leaving a checkable slot unchecked to preserve a spacing rule.
  const starts = [iso(30), iso(60), iso(90)];
  eq(sampleSlotStarts(starts, NOW, spec(5, 2)), starts, "a short payload is sampled whole");
}
{
  // nearCount larger than what is on offer must not eat into the spread budget
  // or produce a short sample.
  const starts = [iso(30), iso(60), iso(90), iso(120), iso(150), iso(180)];
  const picked = sampleSlotStarts(starts, NOW, spec(4, 10));
  eq(picked.length, 4, "nearCount above the sample size still yields exactly sampleSize");
  eq(picked, [iso(30), iso(60), iso(90), iso(120)], "and falls back to the soonest slots");
}
{
  // A spread that lands on the same index twice must not silently shrink the
  // sample: a probe checking 3 slots while reporting 5 would judge a drift
  // share against a denominator it did not measure.
  const starts = [iso(30), iso(60), iso(90), iso(120)];
  const picked = sampleSlotStarts(starts, NOW, spec(4, 1));
  eq(picked.length, 4, "collisions in the spread are backfilled, not dropped");
  eq(new Set(picked).size, 4, "and the backfill never repeats a slot");
}

// --- planDriftAlert: one page for a widespread drift, not one per bucket (#1373) ---
//
// The probe checks ONE bucket per tick, so unlike the empty-bucket sweep it never
// sees the whole picture at once. The drifting set is therefore carried in
// durable per-bucket markers and handed in; every assertion below is about what
// the tick DOES with that set, and the two cases that must never happen are a
// tick that pages twice for one fault and a tick that all-clears something it
// did not measure.
const plan = (over: Partial<Parameters<typeof planDriftAlert>[0]> = {}) =>
  planDriftAlert({
    code: "101",
    drifted: true,
    seenDrifting: [],
    aggregateFiring: false,
    perBucketFiring: [],
    threshold: AGGREGATE_DRIFT_THRESHOLD,
    ...over,
  });
{
  const p = plan();
  eq(p.aggregated, false, "one drifting bucket is not a flood");
  eq(p.pageCode, "101", "so it pages on its own key, naming the bucket to look at");
  eq(p.aggregatePage, false, "and the aggregate stays quiet");
  eq(p.settleCodes, [], "nothing is folded in");
}
{
  const p = plan({ drifted: true, seenDrifting: ["101", "202"] });
  eq(p.aggregated, false, "two below the threshold still page individually");
  eq(p.pageCode, "101", "and this tick's bucket is the one named");
}
{
  // The threshold case. The realistic cause of several at once is calendar sync
  // or the push channels falling behind, which is ONE fault, so it gets one page.
  const p = plan({ drifted: true, seenDrifting: ["202", "303"], perBucketFiring: ["202", "303"] });
  eq(p.aggregated, true, "the threshold turns the flood into one page");
  eq(p.drifting, ["101", "202", "303"], "which names the whole set, this tick's bucket included");
  eq(p.aggregatePage, true, "the aggregate page goes out");
  eq(p.pageCode, null, "and this bucket does NOT also page on its own key");
  eq(p.settleCodes, ["202", "303"], "the pages it supersedes are folded in");
}
{
  // Folding in must not post an all-clear per bucket: sixty notices announcing
  // that sixty pages became one is the same flood wearing a hat.
  const p = plan({ drifted: true, seenDrifting: ["202", "303"], perBucketFiring: ["202", "303"] });
  eq(p.clearCode, null, "no per-bucket all-clear rides along with the aggregate");
  eq(p.clearAggregate, false, "and a page is never also a recovery");
}
{
  // Already aggregated, a fourth bucket joins. It must not page on its own, and
  // it must not re-page the aggregate outside its cooldown either: that is the
  // aggregate key's own throttle to decide, not this planner's.
  const p = plan({ drifted: true, seenDrifting: ["202", "303", "404"], aggregateFiring: true });
  eq(p.aggregated, true, "a fourth drifting bucket stays aggregated");
  eq(p.pageCode, null, "and never pages on its own");
  eq(p.drifting.length, 4, "the set carries all four");
}

// --- the recovery side, which has to aggregate the same way or the flood moves ---
{
  const p = plan({ drifted: false, seenDrifting: ["101"] });
  eq(p.drifting, [], "a measured healthy verdict takes this bucket out of the set");
  eq(p.clearCode, "101", "and clears its own page");
  eq(p.aggregatePage, false, "with nothing aggregate to say");
  eq(p.pageCode, null, "a healthy bucket never pages");
}
{
  const p = plan({ drifted: false, seenDrifting: ["101", "202", "303"], aggregateFiring: true });
  eq(p.aggregated, false, "with this bucket healthy the remaining two are below the threshold");
  eq(p.clearAggregate, true, "so the aggregate is cleared rather than left firing forever");
  eq(p.drifting, ["202", "303"], "and the two still drifting are named, since they page individually next");
  eq(p.clearCode, null, "this bucket's own page was folded in, so there is none to clear");
}
{
  const p = plan({ drifted: false, seenDrifting: ["101"], aggregateFiring: true });
  eq(p.drifting, [], "the last drifting bucket recovering empties the set");
  eq(p.clearAggregate, true, "and clears the aggregate");
}
{
  const p = plan({ drifted: false, seenDrifting: [], aggregateFiring: false });
  eq(p.clearAggregate, false, "a healthy bucket with no aggregate firing clears no aggregate");
}
{
  // The false-recovery defect (#1134): an all-clear may only ever hang off a
  // MEASURED healthy result. A bucket that is still drifting must not clear the
  // aggregate just because this tick happened to look at a different bucket.
  const p = plan({ code: "999", drifted: false, seenDrifting: ["101", "202", "303"], aggregateFiring: true });
  eq(p.drifting, ["101", "202", "303"], "a bucket outside the set leaves the set alone");
  eq(p.aggregated, true, "three still drifting is still a flood");
  eq(p.clearAggregate, false, "so the aggregate stays firing");
}

// --- the aggregate copy ---
{
  const text = formatAvailabilityDriftAggregateAlert({ codes: ["101", "202", "303"], totalBuckets: 60 });
  assert(text.includes("3 of 60"), "the aggregate names how widespread it is");
  assert(text.includes("101") && text.includes("303"), "and names the buckets");
  assert(/sync|push/i.test(text), "and points at the realistic cause rather than the buckets");
  assert(!DASHES.test(text), "no dashes in alert copy");
  assert(!text.startsWith("Slate"), "an alert never opens with the word Slate");
}
{
  // Sixty codes is a wall of text on a phone mid-incident. It must truncate AND
  // say that it did, because a silently cut list reads as the whole set.
  const many = Array.from({ length: 60 }, (_, i) => String(100 + i));
  const text = formatAvailabilityDriftAggregateAlert({ codes: many, totalBuckets: 60 });
  assert(text.includes("60 of 60"), "the COUNT is always the true one");
  assert(/more/i.test(text), "a truncated list says there are more");
  assert(text.length < 600, "and the message stays readable on a phone");
}
{
  const text = formatAvailabilityDriftAggregateAllClear({ stillDrifting: 0, totalBuckets: 60 });
  assert(/no action/i.test(text), "a full recovery says nothing needs doing");
  assert(!DASHES.test(text), "no dashes in the all-clear either");
}
{
  const text = formatAvailabilityDriftAggregateAllClear({ stillDrifting: 2, totalBuckets: 60 });
  assert(/2 of 60/.test(text), "a partial recovery says how many are still wrong");
  assert(/individual/i.test(text), "and that those will page on their own from here");
  assert(!/no action/i.test(text), "and never claims nothing needs doing while two are still wrong");
}
{
  eq(AGGREGATE_DRIFT_CODE, "all", "the aggregate rides in the same key family as the per-bucket pages");
  assert(AGGREGATE_DRIFT_THRESHOLD >= 2, "a threshold below 2 would aggregate a single bucket");
}

// --- classifySlotVerdict: the three outcomes, and which way each one fails ---
{
  eq(classifySlotVerdict(2, 0), "free", "an offered slot with a genuinely free agent is fine");
  eq(classifySlotVerdict(1, 5), "free", "one free agent is enough, however many could not be read");
  eq(
    classifySlotVerdict(0, 0),
    "drift",
    "offering a slot where every eligible agent is really busy IS the defect",
  );
  eq(
    classifySlotVerdict(0, 1),
    "unverified",
    "no free agent, but one could not be READ, is not evidence of drift: the unread agent may be free",
  );
}

// --- summarizeSample: the denominator is what we could actually check ---
{
  const verdicts: SlotVerdict[] = ["free", "drift", "unverified", "free", "unverified"];
  const s = summarizeSample(verdicts);
  eq(s.verified, 3, "verified counts only the slots that produced a real answer");
  eq(s.drifted, 1, "drifted counts the offered-but-busy slots");
  eq(s.unverified, 2, "unverified is reported on its own, never folded into either side");
  eq(s.driftPct, 33, "the share is drift over what was CHECKED, not over what was sampled");
}
{
  const s = summarizeSample(["unverified", "unverified"]);
  eq(s.verified, 0, "a sample that verified nothing has a zero denominator");
  eq(s.driftPct, null, "a share with nothing to divide by is null, never 0 (which reads as healthy)");
}

// --- judgeAvailabilityTruth ---
{
  const v = judgeAvailabilityTruth(summarizeSample(["unverified", "unverified"]), THRESHOLDS);
  eq(v.status, "unverified", "a tick that could check nothing claims nothing");
  assert(v.status !== "healthy", "checking nothing is NOT a clean bill of health, so it cannot all-clear");
}
{
  const v = judgeAvailabilityTruth(summarizeSample(["free", "drift"]), THRESHOLDS);
  eq(v.status, "unverified", "below the minimum checked count there is no honest verdict");
}
{
  const v = judgeAvailabilityTruth(summarizeSample(["free", "free", "free", "free"]), THRESHOLDS);
  eq(v.status, "healthy", "four slots checked and all really free is a measured clean result");
}
{
  // One disagreement in five is a lost race far more often than it is drift.
  const v = judgeAvailabilityTruth(summarizeSample(["free", "free", "free", "free", "drift"]), THRESHOLDS);
  eq(v.status, "healthy", "a single disagreement in a healthy sample does not page");
}
{
  const v = judgeAvailabilityTruth(
    summarizeSample(["drift", "drift", "drift", "free", "unverified"]),
    THRESHOLDS,
  );
  eq(v.status, "drifted", "most of what we offered being genuinely busy is the page");
  if (v.status === "drifted") {
    eq(v.drifted, 3, "the page reports how many offered times were really taken");
    eq(v.verified, 4, "the page reports how many it could actually check");
  }
}
{
  // Exactly at the threshold is healthy: the page is for CROSSING it.
  const v = judgeAvailabilityTruth(
    summarizeSample(["drift", "drift", "free", "free", "free"]),
    { ...THRESHOLDS, driftPct: 40 },
  );
  eq(v.status, "healthy", "a share exactly at the threshold is healthy");
}

// --- copy ---
{
  const msg = formatAvailabilityDriftAlert({ code: "411", drifted: 3, verified: 4, driftPct: 75 });
  assert(msg.includes("411"), "the page names the bucket, so the reader knows where to look");
  assert(msg.includes("3"), "the page states how many offered times were really busy");
  assert(!DASHES.test(msg), "the page uses no em/en dashes (copy rule)");
  assert(!/^Slate\b/.test(msg), "the page does not open with the word Slate");

  const one = formatAvailabilityDriftAlert({ code: "411", drifted: 1, verified: 3, driftPct: 33 });
  assert(
    /\b1 of the 3 checked is already busy\b/.test(one),
    "a single bad time agrees with its verb: 'is already busy', not 'are'",
  );
  assert(
    /\b3 of the 4 checked are already busy\b/.test(msg),
    "several bad times read as 'are already busy'",
  );

  const clear = formatAvailabilityDriftAllClear({ code: "411", verified: 5 });
  assert(clear.includes("411"), "the all-clear names the same bucket it cleared");
  assert(!DASHES.test(clear), "the all-clear uses no em/en dashes");
}

// --- runAvailabilityTruthCheck: the paging decision -------------------------

interface Harness {
  run: () => Promise<TruthResult>;
  notified: { key: string; text: string }[];
  resolved: string[];
  checked: string[][];
  windows: { startIso: string; endIso: string }[];
  settled: string[][];
  marked: { code: string; drifting: boolean }[];
}

function harness(overrides: {
  bucket?: { code: string } | null;
  bucketThrows?: boolean;
  slots?: { starts: string[]; durationMin: number } | null;
  emails?: string[] | null;
  verdicts?: SlotVerdict[];
  verifyThrows?: boolean;
  armed?: boolean;
  seenDrifting?: string[];
  perBucketFiring?: string[];
  aggregateFiring?: boolean;
  contextUnreadable?: boolean;
}): Harness {
  const notified: { key: string; text: string }[] = [];
  const resolved: string[] = [];
  const checked: string[][] = [];
  const windows: { startIso: string; endIso: string }[] = [];
  const settled: string[][] = [];
  const marked: { code: string; drifting: boolean }[] = [];
  const verdicts = overrides.verdicts ?? ["free", "free", "free", "free", "free"];
  let i = 0;
  return {
    notified,
    resolved,
    checked,
    windows,
    settled,
    marked,
    run: () =>
      runAvailabilityTruthCheck({
        nowMs: NOW,
        thresholds: THRESHOLDS,
        alertContext: async () =>
          overrides.contextUnreadable
            ? null
            : {
                seenDrifting: overrides.seenDrifting ?? [],
                perBucketFiring: overrides.perBucketFiring ?? [],
                aggregateFiring: overrides.aggregateFiring ?? false,
                totalBuckets: 60,
              },
        markDrifting: async (code, drifting) => {
          marked.push({ code, drifting });
        },
        settleSilently: async (codes) => {
          settled.push(codes);
        },
        nextBucket: async () => {
          if (overrides.bucketThrows) throw new Error("cursor unreadable");
          return overrides.bucket === undefined ? { code: "411" } : overrides.bucket;
        },
        cachedSlots: async () =>
          overrides.slots === undefined
            ? { starts: [iso(20), iso(40), iso(60), iso(80), iso(100)], durationMin: 30 }
            : overrides.slots,
        eligibleEmails: async () =>
          overrides.emails === undefined ? ["a@x", "b@x"] : overrides.emails,
        verifySlot: async (emails, startIso, endIso) => {
          if (overrides.verifyThrows) throw new Error("google down");
          checked.push(emails);
          windows.push({ startIso, endIso });
          return verdicts[i++] ?? "unverified";
        },
        armed: overrides.armed ?? true,
        cooldownMs: 30 * MIN,
        notify: async (key, _cd, text) => {
          notified.push({ key, text });
        },
        resolve: async (key) => {
          resolved.push(key);
          return true;
        },
      }),
  };
}

// The failure paths: each one claims nothing, in either direction.
{
  const h = harness({ bucket: null });
  eq((await h.run()).status, "skipped", "no bucket to probe is a skip, not a clean result");
  eq(h.resolved.length, 0, "a skipped tick sends no all-clear");
}
{
  const h = harness({ bucketThrows: true });
  eq((await h.run()).status, "skipped", "an unreadable rotation cursor skips the tick");
  eq(h.notified.length, 0, "a skipped tick does not page");
}
{
  const h = harness({ slots: null });
  const out = await h.run();
  eq(out.status, "skipped", "an unreadable slot payload claims nothing");
  eq(h.resolved.length, 0, "an unreadable slot payload does NOT all-clear");
}
{
  const h = harness({ slots: { starts: [], durationMin: 30 } });
  const out = await h.run();
  eq(out.status, "skipped", "a bucket offering no times has nothing to verify, which is not health");
  eq(h.resolved.length, 0, "a bucket with no times sends no all-clear (the empty-bucket check owns that)");
}
{
  const h = harness({ emails: null });
  eq((await h.run()).status, "skipped", "an unreadable eligible set claims nothing");
}
{
  const h = harness({ emails: [] });
  const out = await h.run();
  eq(out.status, "skipped", "a bucket with nobody eligible is not drift: it is the empty-bucket condition");
  eq(h.notified.length, 0, "an unstaffed bucket does not page THIS alert");
}
{
  const h = harness({ verifyThrows: true });
  const out = await h.run();
  eq(out.status, "unverified", "a Google failure leaves the tick unverified, never clean");
  eq(h.resolved.length, 0, "a Google failure sends no all-clear");
  eq(h.notified.length, 0, "a Google failure does not page THIS alert either: it proves nothing about the cache");
}

// The paging gates.
{
  const h = harness({ verdicts: ["drift", "drift", "drift", "free", "free"], armed: true });
  const out = await h.run();
  assert(out.status === "checked" && out.verdict.status === "drifted", "a drifted sample is judged drifted");
  eq(h.notified.length, 1, "an armed drift pages");
  eq(h.notified[0].key, `${AVAILABILITY_TRUTH_ALERT_KEY}:411`, "the key carries the bucket, so a second bucket is not throttled by the first");
  eq(h.resolved.length, 0, "a drift does not also all-clear");
}
{
  const h = harness({ verdicts: ["drift", "drift", "drift", "free", "free"], armed: false });
  const out = await h.run();
  assert(out.status === "checked" && out.verdict.status === "drifted", "a disarmed check still MEASURES the drift");
  eq(h.notified.length, 0, "a disarmed drift observes only (L56)");
  eq(h.resolved.length, 0, "a disarmed drift does not all-clear either");
}
{
  const h = harness({ verdicts: ["free", "free", "free", "free", "free"], armed: true });
  const out = await h.run();
  assert(out.status === "checked" && out.verdict.status === "healthy", "an all-free sample is healthy");
  eq(h.resolved.length, 1, "a MEASURED clean sample sends the all-clear");
  eq(h.resolved[0], `${AVAILABILITY_TRUTH_ALERT_KEY}:411`, "the all-clear clears the same per-bucket key");
}
{
  const h = harness({ verdicts: ["unverified", "unverified", "unverified", "free", "free"], armed: true });
  const out = await h.run();
  assert(out.status === "checked" && out.verdict.status === "unverified", "too few readable slots is unverified");
  eq(h.resolved.length, 0, "an unverified sample does not all-clear");
  eq(h.notified.length, 0, "an unverified sample does not page");
}
{
  const h = harness({});
  await h.run();
  eq(h.checked.length, 5, "every sampled slot is checked");
  eq(
    h.windows[0],
    { startIso: iso(20), endIso: iso(50) },
    "each slot is checked over the BOOKING's whole window, not an instant, so a busy period overlapping it counts",
  );
  assert(
    h.checked.every((emails) => emails.length === 2),
    "each slot is checked against the bucket's whole eligible set, not one agent",
  );
}

// --- the aggregation, end to end through the tick (#1373) ---
const DRIFTED: SlotVerdict[] = ["drift", "drift", "drift", "drift", "drift"];
{
  const h = harness({ verdicts: DRIFTED, seenDrifting: [] });
  const out = await h.run();
  assert(out.status === "checked", "a drifting bucket is a real verdict");
  eq(h.notified.length, 1, "one drifting bucket sends exactly one page");
  eq(h.notified[0].key, `${AVAILABILITY_TRUTH_ALERT_KEY}:411`, "on its own key");
  eq(h.marked, [{ code: "411", drifting: true }], "and records that this bucket is drifting");
  eq(h.settled.length, 0, "with nothing to fold in");
}
{
  const h = harness({
    verdicts: DRIFTED,
    seenDrifting: ["101", "202"],
    perBucketFiring: ["101", "202"],
  });
  await h.run();
  eq(h.notified.length, 1, "a widespread drift still sends exactly ONE message");
  eq(
    h.notified[0].key,
    `${AVAILABILITY_TRUTH_ALERT_KEY}:${AGGREGATE_DRIFT_CODE}`,
    "and it is the aggregate, not this bucket's own page",
  );
  assert(h.notified[0].text.includes("101"), "which names the other drifting buckets");
  assert(h.notified[0].text.includes("411"), "and this one");
  eq(
    h.settled,
    [[`${AVAILABILITY_TRUTH_ALERT_KEY}:101`, `${AVAILABILITY_TRUTH_ALERT_KEY}:202`]],
    "the superseded per-bucket pages are folded in silently, by their real alert keys",
  );
  eq(h.resolved.length, 0, "folding in posts no all-clears: that is the same flood wearing a hat");
}
{
  const h = harness({ verdicts: ["free", "free", "free", "free", "free"], seenDrifting: ["411"] });
  await h.run();
  eq(h.marked, [{ code: "411", drifting: false }], "a measured healthy verdict drops the marker");
  eq(h.resolved, [`${AVAILABILITY_TRUTH_ALERT_KEY}:411`], "and clears that bucket's own page");
}
{
  const h = harness({
    verdicts: ["free", "free", "free", "free", "free"],
    seenDrifting: ["411"],
    aggregateFiring: true,
  });
  await h.run();
  eq(
    h.resolved,
    [`${AVAILABILITY_TRUTH_ALERT_KEY}:${AGGREGATE_DRIFT_CODE}`],
    "the last drifting bucket recovering clears the AGGREGATE, not sixty per-bucket notices",
  );
}
{
  // A tick that could not read the alert state has measured nothing about how
  // widespread this is. It may still PAGE (a flood beats silence when something
  // is genuinely wrong) but it must never all-clear on an unread state.
  const h = harness({ verdicts: DRIFTED, contextUnreadable: true });
  await h.run();
  eq(h.notified.length, 1, "an unreadable alert state still pages");
  eq(h.notified[0].key, `${AVAILABILITY_TRUTH_ALERT_KEY}:411`, "on the per-bucket key, never the aggregate");
}
{
  const h = harness({ verdicts: ["free", "free", "free", "free", "free"], contextUnreadable: true });
  await h.run();
  eq(h.resolved.length, 0, "an unreadable alert state sends NO all-clear");
}
{
  // Marker upkeep must not depend on the page being armed, or arming #1371 would
  // start from an empty set and under-report how widespread the drift already is.
  const h = harness({ verdicts: DRIFTED, armed: false });
  await h.run();
  eq(h.notified.length, 0, "a disarmed probe still sends nothing");
  eq(h.marked, [{ code: "411", drifting: true }], "but still records the drift for when it is armed");
}
{
  // The unverified path: measured NOTHING, so it must leave the set exactly as
  // it found it, in both directions.
  const h = harness({ verifyThrows: true, seenDrifting: ["411"] });
  await h.run();
  eq(h.marked.length, 0, "a tick that could not verify touches no marker");
  eq(h.resolved.length, 0, "and clears nothing");
  eq(h.notified.length, 0, "and pages nothing");
}
{
  const h = harness({ bucket: null, seenDrifting: ["411"] });
  await h.run();
  eq(h.marked.length, 0, "a skipped tick touches no marker either");
}

finish();
