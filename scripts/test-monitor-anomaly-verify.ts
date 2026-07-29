// Re-verification of a suspected availability anomaly before anyone is paged
// (#1167). The monitor used to page on the FIRST tick that saw the cache
// disagree with a live recompute, so a momentary disagreement (a read landing
// mid-write, a recompute that briefly answered wrong) woke on-call for a fault
// that was already gone. This re-checks a suspect bucket a few more times and
// only confirms the ones that KEEP disagreeing.
//
// The whole risk of a step like this is that it becomes a way to lose an alert:
// a verification that cannot run must never be read as "no anomaly found". So
// every inconclusive path here fails CLOSED (keep the finding, page), and each
// of those paths is pinned below.
//
// Run: node --experimental-strip-types scripts/test-monitor-anomaly-verify.ts
import { verifyAnomalies, type AnomalyVerifyDeps } from "../src/lib/monitor/anomaly-verify.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const NOW = Date.UTC(2026, 5, 23, 18, 0, 0);

/**
 * One fake world. Each bucket declares a SEQUENCE of observations, one per
 * attempt, so a bucket can disagree once and then agree. The last entry repeats
 * once the sequence runs out.
 */
type Obs = { cached?: number | null; recompute?: number | null; cachedThrows?: boolean; recomputeThrows?: boolean };

function harness(config: {
  dataAnomaly?: string[];
  unverified?: string[];
  obs?: Record<string, Obs[]>;
  attempts?: number;
  maxBuckets?: number;
  delayMs?: number;
  deadlineMs?: number;
  nowMs?: number;
}) {
  const waits: number[] = [];
  const cachedCalls: string[] = [];
  const recomputeCalls: string[] = [];
  const seen = new Map<string, number>();

  /** The observation for `code`'s next attempt (clamped to the last entry). */
  const next = (code: string): Obs => {
    const list = config.obs?.[code] ?? [];
    const i = seen.get(code) ?? 0;
    seen.set(code, i + 1);
    return list[Math.min(i, list.length - 1)] ?? {};
  };
  // Both reads happen in the same attempt, so they must see the SAME entry.
  const current = new Map<string, Obs>();

  const deps: AnomalyVerifyDeps = {
    dataAnomaly: config.dataAnomaly ?? [],
    unverified: config.unverified ?? [],
    attempts: config.attempts ?? 2,
    delayMs: config.delayMs ?? 2000,
    maxBuckets: config.maxBuckets ?? 8,
    deadlineMs: config.deadlineMs ?? NOW + 120_000,
    now: () => config.nowMs ?? NOW,
    cachedSlots: async (code) => {
      cachedCalls.push(code);
      const obs = next(code);
      current.set(code, obs);
      if (obs.cachedThrows) throw new Error("cached read boom");
      return obs.cached === undefined ? 0 : obs.cached;
    },
    recomputeSlots: async (code) => {
      recomputeCalls.push(code);
      const obs = current.get(code) ?? {};
      if (obs.recomputeThrows) throw new Error("recompute boom");
      return obs.recompute === undefined ? 0 : obs.recompute;
    },
    wait: async (ms) => {
      waits.push(ms);
    },
  };

  return { deps, waits, cachedCalls, recomputeCalls, run: () => verifyAnomalies(deps) };
}

// A bucket that keeps disagreeing is the real thing: confirmed, so it still
// heals and still pages exactly as before this change.
{
  const h = harness({
    dataAnomaly: ["411"],
    obs: { "411": [{ cached: 0, recompute: 4 }] },
  });
  const res = await h.run();
  eq(res.dataAnomaly, ["411"], "a bucket that disagrees on every attempt is a confirmed anomaly");
  eq(res.resolved, [], "a confirmed anomaly is not counted as resolved");
  assert(res.skipped === false, "verification actually ran");
}

// The blip this exists for: the cached row catches up on a retry, so there is
// no fault to page about.
{
  const h = harness({
    dataAnomaly: ["411"],
    obs: { "411": [{ cached: 0, recompute: 4 }, { cached: 6, recompute: 4 }] },
  });
  const res = await h.run();
  eq(res.dataAnomaly, [], "a bucket whose cache catches up is NOT a confirmed anomaly");
  eq(res.resolved, ["411"], "the caught-up bucket is reported as resolved");
  eq(res.bookedSolid, [], "a caught-up cache is not booked solid: it has times");
}

// The other way a suspicion dissolves: the recompute stops finding times, so the
// empty cache was right and the calendars really are full.
{
  const h = harness({
    dataAnomaly: ["411"],
    obs: { "411": [{ cached: 0, recompute: 4 }, { cached: 0, recompute: 0 }] },
  });
  const res = await h.run();
  eq(res.dataAnomaly, [], "a bucket whose recompute drops to zero is not an anomaly");
  eq(res.bookedSolid, ["411"], "it is reclassified as booked solid, which whispers instead of paging");
  eq(res.resolved, [], "booked solid is a real classification, not a resolved blip");
}

// An initially UNVERIFIED bucket whose recompute recovers and finds times is a
// real anomaly, so re-verification upgrades it rather than leaving it vague.
// This is the case that also earns it a self-heal it would never have had.
{
  const h = harness({
    unverified: ["411"],
    obs: { "411": [{ cached: 0, recompute: null }, { cached: 0, recompute: 4 }] },
  });
  const res = await h.run();
  eq(res.dataAnomaly, ["411"], "a recovered recompute that finds times reclassifies as a data anomaly");
  eq(res.unverified, [], "it is no longer merely unverified");
}

// An unverified bucket whose recompute keeps failing stays unverified: still
// reported, because we never learned anything either way.
{
  const h = harness({
    unverified: ["411"],
    obs: { "411": [{ cached: 0, recompute: null }] },
  });
  const res = await h.run();
  eq(res.unverified, ["411"], "a recompute that never recovers stays unverified");
  eq(res.resolved, [], "a bucket we could not verify is never treated as resolved");
}

// An unverified bucket whose recompute recovers and agrees with the empty cache
// is booked solid, which is the one case where re-verification SILENCES a page
// legitimately: we now know the calendars are genuinely full.
{
  const h = harness({
    unverified: ["411"],
    obs: { "411": [{ cached: 0, recompute: null }, { cached: 0, recompute: 0 }] },
  });
  const res = await h.run();
  eq(res.bookedSolid, ["411"], "a recovered recompute agreeing with the empty cache is booked solid");
  eq(res.unverified, [], "it is no longer unverified once the recompute answered");
}

// --- Fail closed. Every path below is a way verification could LOSE a real
// finding, which would be worse than the false page it exists to prevent. ---

// A cached read that throws tells us nothing, so the suspicion stands.
{
  const h = harness({
    dataAnomaly: ["411"],
    obs: { "411": [{ cached: 0, recompute: 4 }, { cachedThrows: true }] },
  });
  const res = await h.run();
  eq(res.dataAnomaly, ["411"], "a throwing cached read leaves the anomaly confirmed (fails closed)");
  eq(res.resolved, [], "a read that threw is never a resolution");
}

// Same for a recompute that throws mid-verification.
{
  const h = harness({
    dataAnomaly: ["411"],
    obs: { "411": [{ cached: 0, recompute: 4 }, { cached: 0, recomputeThrows: true }] },
  });
  const res = await h.run();
  eq(res.dataAnomaly, ["411"], "a throwing recompute leaves the anomaly confirmed (fails closed)");
}

// A cached read that returns null (the row could not be read) is not evidence
// the cache is fine.
{
  const h = harness({
    dataAnomaly: ["411"],
    obs: { "411": [{ cached: null, recompute: 4 }] },
  });
  const res = await h.run();
  eq(res.dataAnomaly, ["411"], "an unreadable cached row leaves the anomaly confirmed");
}

// Past the tick deadline there is no budget to re-check, so the original
// finding stands and pages. Verification must never cost us the alert.
{
  const h = harness({
    dataAnomaly: ["411"],
    unverified: ["412"],
    deadlineMs: NOW - 1,
    obs: { "411": [{ cached: 6 }], "412": [{ cached: 6 }] },
  });
  const res = await h.run();
  eq(res.dataAnomaly, ["411"], "past the deadline the anomaly keeps its original classification");
  eq(res.unverified, ["412"], "past the deadline the unverified bucket stays unverified");
  eq(res.resolved, [], "nothing is resolved on a deadline skip, even though a re-read would have said so");
  assert(res.skipped === true, "the result records that verification did not run");
  eq(h.cachedCalls, [], "no verification read is issued past the deadline");
}

// A BROAD anomaly is an outage, not a blip. Skip verification and page now,
// rather than spending the shared subrequest budget re-checking 50 buckets.
{
  const codes = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
  const h = harness({
    dataAnomaly: codes,
    maxBuckets: 8,
    obs: Object.fromEntries(codes.map((c) => [c, [{ cached: 9 }]])),
  });
  const res = await h.run();
  eq(res.dataAnomaly, codes, "a broad anomaly is confirmed without re-verification");
  assert(res.skipped === true, "the result records the skip");
  assert((res.reason ?? "").includes("broad"), "the skip reason says it was broad");
  eq(h.cachedCalls, [], "a broad anomaly issues no verification reads");
}

// Exactly at the cap still verifies: the bypass is for more than maxBuckets.
{
  const codes = ["1", "2", "3", "4", "5", "6", "7", "8"];
  const h = harness({
    dataAnomaly: codes,
    maxBuckets: 8,
    obs: Object.fromEntries(codes.map((c) => [c, [{ cached: 9 }]])),
  });
  const res = await h.run();
  eq(res.dataAnomaly, [], "a set exactly at the cap is still verified");
  assert(res.skipped === false, "at the cap, verification runs");
}

// Zero attempts disables the feature without changing what gets reported, so it
// can be turned off in config and still behave like the pre-#1167 monitor.
{
  const h = harness({
    dataAnomaly: ["411"],
    attempts: 0,
    obs: { "411": [{ cached: 9 }] },
  });
  const res = await h.run();
  eq(res.dataAnomaly, ["411"], "zero attempts confirms the original finding unchanged");
  eq(h.cachedCalls, [], "zero attempts issues no reads");
}

// Nothing suspected: no reads, no waiting, and nothing invented.
{
  const h = harness({});
  const res = await h.run();
  eq(res.dataAnomaly, [], "a clean tick confirms no anomalies");
  eq(h.waits, [], "a clean tick never sleeps");
  eq(h.cachedCalls, [], "a clean tick issues no verification reads");
}

// It waits before re-reading, giving an in-flight recompute a moment to land.
{
  const h = harness({
    dataAnomaly: ["411"],
    attempts: 3,
    delayMs: 1500,
    obs: { "411": [{ cached: 7 }] },
  });
  await h.run();
  eq(h.waits, [1500], "it waits before the re-read, and settles in one round when the cache has caught up");
  eq(h.cachedCalls, ["411"], "a bucket settled on the first re-check is read once");
}

// Stopping early matters because the attempts are a budget: a bucket that
// settles part way through must not burn the rest of them.
{
  const h = harness({
    dataAnomaly: ["411"],
    attempts: 4,
    delayMs: 1500,
    obs: { "411": [{ cached: 0, recompute: 4 }, { cached: 7 }] },
  });
  await h.run();
  eq(h.waits.length, 2, "it stops after the round that settles the bucket, not after all 4 attempts");
}

// A bucket that never settles uses the whole budget and is then confirmed.
{
  const h = harness({
    dataAnomaly: ["411"],
    attempts: 3,
    delayMs: 1500,
    obs: { "411": [{ cached: 0, recompute: 4 }] },
  });
  const res = await h.run();
  eq(h.waits.length, 3, "a persistently disagreeing bucket is re-checked the full number of attempts");
  eq(res.dataAnomaly, ["411"], "and is confirmed at the end of them");
}

// Two buckets, one real and one a blip: they are judged independently.
{
  const h = harness({
    dataAnomaly: ["411", "412"],
    obs: {
      "411": [{ cached: 0, recompute: 4 }],
      "412": [{ cached: 0, recompute: 4 }, { cached: 5 }],
    },
  });
  const res = await h.run();
  eq(res.dataAnomaly, ["411"], "the persistently disagreeing bucket is confirmed");
  eq(res.resolved, ["412"], "the blip beside it is resolved independently");
}

finish();
