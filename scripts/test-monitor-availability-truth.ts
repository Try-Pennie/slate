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
  runAvailabilityTruthCheck,
  AVAILABILITY_TRUTH_ALERT_KEY,
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
}

function harness(overrides: {
  bucket?: { code: string } | null;
  bucketThrows?: boolean;
  slots?: { starts: string[]; durationMin: number } | null;
  emails?: string[] | null;
  verdicts?: SlotVerdict[];
  verifyThrows?: boolean;
  armed?: boolean;
}): Harness {
  const notified: { key: string; text: string }[] = [];
  const resolved: string[] = [];
  const checked: string[][] = [];
  const windows: { startIso: string; endIso: string }[] = [];
  const verdicts = overrides.verdicts ?? ["free", "free", "free", "free", "free"];
  let i = 0;
  return {
    notified,
    resolved,
    checked,
    windows,
    run: () =>
      runAvailabilityTruthCheck({
        nowMs: NOW,
        thresholds: THRESHOLDS,
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

finish();
