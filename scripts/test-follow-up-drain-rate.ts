// The share of confirms that answered the booking and left the work after the save
// to the reservation drain, paged on a rate (#3267). Run:
//   node --experimental-strip-types scripts/test-follow-up-drain-rate.ts
//
// Every branch of the judgement, driven through the real window machinery with an
// in memory state row: what pages, what stays quiet because it measured too little,
// what clears and only off a measured clean run, and that a read or a write that
// fails sends nothing in either direction.
import {
  FOLLOW_UP_DRAIN_ALERT_KEY,
  FOLLOW_UP_DRAIN_THRESHOLDS,
  FOLLOW_UP_LEFT_TO_DRAIN_OUTCOME,
  followUpReading,
  formatFollowUpDrainAllClear,
  formatFollowUpDrainPage,
  judgeFollowUpDrain,
  runFollowUpDrainCheck,
  type FollowUpDrainResult,
} from "../src/lib/monitor/follow-up-drain-rate.ts";
import { OUTCOME_ORDER } from "../src/lib/monitor/booking-api-outcome.ts";
import type { RateWindowState } from "../src/lib/monitor/booking-failure-rate.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const T = FOLLOW_UP_DRAIN_THRESHOLDS;
const MIN = 60_000;
const DAY = "2026-10-16";
const T0 = Date.UTC(2026, 9, 16, 14, 0, 0);
/** The em and en dash, built from their code points so this file holds neither. */
const DASH_PUNCTUATION = new RegExp(`[${String.fromCharCode(0x2014, 0x2013)}]`);

/** One monitor lane: an in memory state row and everything it sent. */
function lane() {
  let state: RateWindowState | null = null;
  const pages: { key: string; cooldownMs: number; text: string }[] = [];
  const resolved: { key: string; text: string }[] = [];
  let saves = 0;
  async function tick(
    atMs: number,
    created: number,
    left: number,
    opts: { day?: string; readFails?: boolean; loadFails?: boolean; saveFails?: boolean } = {},
  ): Promise<FollowUpDrainResult | Error> {
    try {
      return await runFollowUpDrainCheck({
        nowMs: atMs,
        readToday: async () => {
          if (opts.readFails) throw new Error("booking_api_outcome_mix: statement timeout");
          return followUpReading(opts.day ?? DAY, created, left);
        },
        loadState: async () => {
          if (opts.loadFails) throw new Error("booking_failure_rate_state: statement timeout");
          return state;
        },
        saveState: async (next) => {
          if (opts.saveFails) throw new Error("booking_failure_rate_state write failed");
          saves += 1;
          state = next;
        },
        thresholds: T,
        cooldownMs: 24 * 60 * MIN,
        notify: async (key, cooldownMs, text) => {
          pages.push({ key, cooldownMs, text });
        },
        resolve: async (key, text) => {
          resolved.push({ key, text });
          return true;
        },
      });
    } catch (err) {
      return err as Error;
    }
  }
  return { tick, pages, resolved, saves: () => saves };
}

const statusOf = (r: FollowUpDrainResult | Error) => (r instanceof Error ? "error" : r.status);

// --- the counter is outside the failure share -----------------------------------
{
  // The race tally's trick: a name outside OUTCOME_ORDER never enters the failure
  // share's denominator, so counting these cannot make a real outage look smaller.
  assert(
    !(OUTCOME_ORDER as readonly string[]).includes(FOLLOW_UP_LEFT_TO_DRAIN_OUTCOME),
    "the tally row sits outside the outcomes the failure share sums",
  );
  eq(FOLLOW_UP_DRAIN_ALERT_KEY, "booking_follow_up_left_to_drain", "the alert key is stable");
  const r = followUpReading(DAY, 40, 3);
  eq(r.attempts, 40, "the denominator is the confirms that committed");
  eq(r.failures, 3, "the numerator is the ones that left work to the drain");
}

// --- the numbers hold together ----------------------------------------------------
{
  // At the confirm floor the minimum count is already over the share, so past the
  // floor the share rule, not the count floor, decides the hour.
  assert(T.minLeft * 100 > T.sharePct * T.minConfirms, "the minimum count at the floor is over the share");
  assert(T.saturationPct > T.sharePct, "saturation is louder than the share");
  assert(T.recent.windowMs < T.windowMs, "the recent run sits inside the judged window");
}

// --- the first reading records no interval ---------------------------------------
{
  const l = lane();
  const r = await l.tick(T0, 100, 0);
  eq(statusOf(r), "rebased", "a first reading is a baseline, not a measurement");
  eq(l.pages.length + l.resolved.length, 0, "and it sends nothing either way");
  eq(l.saves(), 1, "but the baseline is kept, or every tick would rebase for ever");
}

// --- a cluster over the share pages ------------------------------------------------
{
  const l = lane();
  await l.tick(T0, 100, 0);
  const r = await l.tick(T0 + 5 * MIN, 120, 5);
  eq(statusOf(r), "paged", "5 of 20 committed confirms left to the drain pages");
  eq(l.pages.length, 1, "one page");
  eq(l.pages[0]?.key, FOLLOW_UP_DRAIN_ALERT_KEY, "on its own key");
  assert(
    l.pages[0]?.text.startsWith("5 of 20 confirmed bookings in the last 60 minutes (25%)") ?? false,
    "naming the counts and the share",
  );
  eq(l.resolved.length, 0, "and clears nothing");
}

// --- a quiet hour cannot page on one (L716) ---------------------------------------
{
  const l = lane();
  await l.tick(T0, 100, 0);
  const r = await l.tick(T0 + 5 * MIN, 104, 1);
  eq(statusOf(r), "held", "1 of 4 is too little to judge");
  if (!(r instanceof Error) && r.status === "held") eq(r.verdict.status, "insufficient", "and is recorded as unmeasured");
  eq(l.pages.length + l.resolved.length, 0, "it pages nothing and clears nothing");
}
{
  // Two left in a small hour: under the count floor, so still nothing, even at 2 of 4.
  const l = lane();
  await l.tick(T0, 100, 0);
  await l.tick(T0 + 5 * MIN, 104, 2);
  eq(l.pages.length, 0, "two unlucky saves never page");
}

// --- a total failure on a tiny sample still pages (L139) ---------------------------
{
  const l = lane();
  await l.tick(T0, 100, 0);
  const r = await l.tick(T0 + 5 * MIN, 104, 3);
  eq(statusOf(r), "paged", "3 of 4 pages under the floor");
  if (!(r instanceof Error) && r.status === "paged" && r.verdict.status === "breach") {
    eq(r.verdict.trigger, "saturation", "by saturation, not the share");
  }
}

// --- the share is exceeded, not met ------------------------------------------------
{
  const l = lane();
  await l.tick(T0, 100, 0);
  const r = await l.tick(T0 + 5 * MIN, 130, 3);
  eq(l.pages.length, 0, "3 of 30 is exactly 10 percent, which does not exceed it");
  // Nor is it a clean run (10 percent left is over 5), so nothing clears either.
  eq(l.resolved.length, 0, "and it is not clean enough to clear");
  if (!(r instanceof Error) && r.status === "held") eq(r.verdict.status, "under", "judged, under the line");
}

// --- the all clear hangs off a measured clean run ------------------------------------
{
  const l = lane();
  await l.tick(T0, 100, 0);
  await l.tick(T0 + 5 * MIN, 120, 5); // the cluster: pages
  eq(l.pages.length, 1, "the cluster paged");
  // Clean confirms every five minutes. While the cluster's sample is inside the
  // recent half hour the run is not clean, so nothing clears.
  let created = 120;
  for (let m = 10; m <= 30; m += 5) {
    created += 4;
    await l.tick(T0 + m * MIN, created, 5);
  }
  eq(l.resolved.length, 0, "no all clear while the cluster is still inside the recent run");
  // Still over the line and not yet a clean run, so each tick asks again; the
  // dispatcher's own throttle (the key's cooldown) is what keeps that to one post.
  assert(l.pages.length > 1, "the page is asked for on every tick the burst is still current");
  const pagesBefore = l.pages.length;
  // Once the cluster ages out of the last 30 minutes, the run is clean and measured.
  created += 4;
  const r = await l.tick(T0 + 40 * MIN, created, 5);
  eq(statusOf(r), "cleared", "a measured clean half hour clears");
  eq(l.resolved[0]?.key, FOLLOW_UP_DRAIN_ALERT_KEY, "on the key it paged on");
  assert(l.resolved[0]?.text.includes("none of the last") ?? false, "saying none were left in the recent run");
  // The cluster is still inside the judged hour, and is NOT paged again off it.
  eq(l.pages.length, pagesBefore, "a burst that has measurably ended is not paged again");
}
{
  // A quiet half hour after a page clears nothing: too few confirms is not a clean run.
  const l = lane();
  await l.tick(T0, 100, 0);
  await l.tick(T0 + 5 * MIN, 120, 5);
  await l.tick(T0 + 40 * MIN, 122, 5);
  eq(l.resolved.length, 0, "two clean confirms in half an hour measured nothing");
}

// --- a failed read or write sends nothing either way -------------------------------
{
  const l = lane();
  await l.tick(T0, 100, 0);
  await l.tick(T0 + 5 * MIN, 120, 5);
  const before = { pages: l.pages.length, resolved: l.resolved.length, saves: l.saves() };
  const r1 = await l.tick(T0 + 40 * MIN, 140, 5, { readFails: true });
  assert(r1 instanceof Error, "a failed tally read throws, for the step's boundary to record");
  const r2 = await l.tick(T0 + 40 * MIN, 140, 5, { loadFails: true });
  assert(r2 instanceof Error, "a failed state read throws");
  const r3 = await l.tick(T0 + 40 * MIN, 140, 5, { saveFails: true });
  assert(r3 instanceof Error, "a failed state write throws");
  eq(l.pages.length, before.pages, "none of them pages");
  eq(before.resolved, 0, "nothing had cleared before the failures either");
  eq(l.resolved.length, 0, "none of them clears, though the run would have read clean");
  eq(l.saves(), before.saves, "and none of them moved the window");
  // Control: the same tick with nothing failing does clear, so the silence above
  // was the failures and not a run that could never have cleared (L1).
  const r4 = await l.tick(T0 + 40 * MIN, 140, 5);
  eq(statusOf(r4), "cleared", "control: with the reads working, that tick clears");
}

// --- a new day rebases rather than inventing a delta --------------------------------
{
  const l = lane();
  await l.tick(T0, 400, 2);
  const r = await l.tick(T0 + 5 * MIN, 3, 0, { day: "2026-10-17" });
  eq(statusOf(r), "rebased", "the counter restarting at midnight is a rebase");
  eq(l.pages.length + l.resolved.length, 0, "and sends nothing");
}

// --- the judge alone ----------------------------------------------------------------
{
  const state: RateWindowState = {
    day: DAY,
    attempts: 0,
    failures: 0,
    byCode: {},
    samples: [
      { atMs: T0 - 70 * MIN, attempts: 10, failures: 10, byCode: {} },
      { atMs: T0 - 10 * MIN, attempts: 12, failures: 0, byCode: {} },
    ],
  };
  const v = judgeFollowUpDrain(state, T0, T);
  eq(v.status, "under", "a sample older than the hour is not judged");
  eq(v.confirms, 12, "only the hour's confirms are counted");
}

// --- the copy ------------------------------------------------------------------------
{
  const page = formatFollowUpDrainPage({ confirms: 1, left: 1, pct: 100 }, 60);
  assert(page.startsWith("1 of 1 confirmed booking in"), "singular reads as singular");
  const clear = formatFollowUpDrainAllClear({ attempts: 24, failures: 1 }, 30);
  assert(clear.includes("1 of the last 24 confirmed bookings"), "a straggler in the clean run is named, not hidden");
  for (const text of [page, clear, formatFollowUpDrainPage({ confirms: 20, left: 5, pct: 25 }, 60)]) {
    assert(!DASH_PUNCTUATION.test(text), "no dash punctuation");
    assert(!text.startsWith("Slate"), "does not open with the app's own name");
  }
}

finish();
