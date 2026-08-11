/**
 * Pure logic for the availability-truth probe (#1315): are the times Slate is
 * OFFERING actually free on the real calendars?
 *
 * The leading half of the pair with #1313. That one sees customers already being
 * turned away; this one is meant to notice that the availability is wrong before
 * anyone hits it. On 2026-08-06 cal.com's own diagnosis of their incident was
 * that "the slots we fetch on the booker doesn't match exactly what the hosts
 * true availability is", and nothing on their side reported it.
 *
 * Slate carries the same exposure BY DESIGN: the booker reads the cached
 * busy_blocks index and never live Google, and the only live check is
 * verify-on-book at confirm time. Nothing measured whether the published
 * availability was TRUE. The existing data-anomaly probe does not close this: it
 * compares the cached slot row against a live RECOMPUTE, and the recompute reads
 * busy_blocks too, so it can only catch the row lagging the index, never the
 * index having drifted from Google.
 *
 * The distinction every branch here turns on: a slot we could not CHECK is not a
 * slot we checked and found fine. Google refusing a calendar has to leave the
 * sample smaller, never cleaner, because the alternative (scoring an unreadable
 * calendar as "not free") turns every Google blip into a drift page, and scoring
 * it as "free" hides the very thing this exists to find.
 *
 * No `@/` imports, so scripts/test-monitor-availability-truth.ts drives every
 * branch node-natively; the Google and DB work is injected by the caller.
 */

/** alert_state key PREFIX. The code appends the bucket, so a second drifting
 *  bucket is not silenced by the first one's cooldown. */
export const AVAILABILITY_TRUTH_ALERT_KEY = "availability_drift";

/** What one sampled slot turned out to be. */
export type SlotVerdict =
  /** At least one eligible agent really is free: the offer is honest. */
  | "free"
  /** Every eligible agent read cleanly, and every one of them is busy. */
  | "drift"
  /** No free agent found, but at least one could not be read, so we cannot tell. */
  | "unverified";

export interface TruthThresholds {
  /** How many of the soonest slots to check per tick. */
  sampleSize: number;
  /** Skip slots closer than this: they are about to be verified on book anyway,
   *  and a booking landing mid-probe would read as drift. */
  leadMs: number;
  /** Below this many slots actually checked, there is no honest verdict. */
  minVerified: number;
  /** Drift share (percent of CHECKED slots) that must be EXCEEDED to page. */
  driftPct: number;
}

/**
 * The soonest `limit` slot starts at or after `nowMs + leadMs`, in time order.
 *
 * These are the slots most likely to be booked next, so they are where a stale
 * cache costs a customer soonest. An unreadable start is DROPPED rather than
 * sorted: `Date.parse` yields NaN, and a NaN sort key would shuffle the sample
 * arbitrarily while looking like a normal result (#1169).
 */
export function sampleSlotStarts(
  startsIso: string[],
  nowMs: number,
  leadMs: number,
  limit: number,
): string[] {
  const floor = nowMs + leadMs;
  return startsIso
    // parse-ok: this is the site that REMOVES unreadable starts rather than
    // comparing them. The very next line drops every non-finite ms, which is why
    // an unreadable slot can never reach the sample, the sort, or the live check.
    .map((iso) => ({ iso, ms: Date.parse(iso) }))
    .filter((s) => Number.isFinite(s.ms) && s.ms >= floor)
    .sort((a, b) => a.ms - b.ms)
    .slice(0, limit)
    .map((s) => s.iso);
}

/**
 * One slot's verdict from the live read.
 *
 * A slot is offered because SOME eligible agent was believed free, so one
 * genuinely free agent vindicates it however many others are busy or unreadable.
 * The order of the two guards matters: an unreadable calendar only matters when
 * nothing was free, and it then blocks the drift call rather than confirming it.
 */
export function classifySlotVerdict(freeCount: number, unverifiedCount: number): SlotVerdict {
  if (freeCount > 0) return "free";
  if (unverifiedCount > 0) return "unverified";
  return "drift";
}

export interface TruthSummary {
  /** Slots that produced a real answer: free plus drift. The denominator. */
  verified: number;
  drifted: number;
  unverified: number;
  /** Drift as a percentage of what was CHECKED, or null when nothing was. */
  driftPct: number | null;
}

/**
 * Fold the sample. `driftPct` is null rather than 0 when nothing could be
 * checked, because 0 is the healthy reading and would be indistinguishable from
 * a perfect sample (L11).
 */
export function summarizeSample(verdicts: SlotVerdict[]): TruthSummary {
  const drifted = verdicts.filter((v) => v === "drift").length;
  const unverified = verdicts.filter((v) => v === "unverified").length;
  const verified = verdicts.length - unverified;
  return {
    verified,
    drifted,
    unverified,
    driftPct: verified === 0 ? null : Math.round((drifted / verified) * 100),
  };
}

export type TruthVerdict =
  | { status: "unverified"; verified: number; unverified: number }
  | { status: "healthy"; verified: number; drifted: number; driftPct: number }
  | { status: "drifted"; verified: number; drifted: number; driftPct: number };

/**
 * Judge the sample.
 *
 * Three outcomes for the same reason as its sibling in booking-failure-rate.ts:
 * a tick that could not check enough slots measured nothing, so it must neither
 * page nor send an all-clear. The share is compared before rounding so a true
 * 40.5% cannot present as an at-threshold 40 and pass.
 */
export function judgeAvailabilityTruth(
  summary: TruthSummary,
  thresholds: TruthThresholds,
): TruthVerdict {
  if (summary.verified < thresholds.minVerified) {
    return { status: "unverified", verified: summary.verified, unverified: summary.unverified };
  }
  const over = summary.drifted * 100 > thresholds.driftPct * summary.verified;
  return {
    status: over ? "drifted" : "healthy",
    verified: summary.verified,
    drifted: summary.drifted,
    driftPct: summary.driftPct ?? 0,
  };
}

/** The verb has to agree with the count, or the singular page reads as broken
 *  English on the one screen where a reader is least patient with it. */
function isAre(n: number): string {
  return n === 1 ? "is" : "are";
}

/**
 * The page. Names the bucket (so the reader knows where to look), what was
 * measured, and the one action that actually helps: a drifted cache is what the
 * sync lane exists to reconverge, so the question is whether that lane is
 * working, not whether to edit anything by hand.
 */
export function formatAvailabilityDriftAlert(input: {
  code: string;
  drifted: number;
  verified: number;
  driftPct: number;
}): string {
  return (
    `Bucket ${input.code} is offering times that are not free: ` +
    `${input.drifted} of the ${input.verified} checked ${isAre(input.drifted)} already busy ` +
    `on every eligible agent's calendar (${input.driftPct}%). ` +
    `Customers picking those times will be refused at the last step. ` +
    `Check that calendar sync and the push channels are keeping up.`
  );
}

/** The all-clear, hung off a MEASURED clean sample. */
export function formatAvailabilityDriftAllClear(input: { code: string; verified: number }): string {
  return (
    `Bucket ${input.code} is offering times that really are free: ` +
    `all ${input.verified} checked were free on a live calendar read.`
  );
}

export type TruthResult =
  /** Nothing to probe, or the inputs could not be read. Claims nothing. */
  | { status: "skipped"; why: string }
  /** Google could not be read at all, so the cache was never compared. */
  | { status: "unverified"; code: string }
  | { status: "checked"; code: string; armed: boolean; verdict: TruthVerdict };

/**
 * The monitor-lane step: pick the next bucket on the rotation, sample the
 * soonest times it is offering, check each against live Google, and decide
 * whether anyone hears about it.
 *
 * Every input that cannot be read ends the tick as `skipped` or `unverified`,
 * never as a clean sample. Two of those deserve naming because the tempting
 * reading is the wrong one:
 *
 *  - A bucket offering NO times is not drift and must not page here. Zero times
 *    is the empty-bucket / dead-end condition, which the availability scan
 *    already owns, and claiming it as drift would double-page one fault.
 *  - A bucket with NOBODY eligible is the same story. A slot with no eligible
 *    agent trivially has no free agent, so scoring it as drift would turn an
 *    unstaffed bucket into a cache-integrity page.
 */
export async function runAvailabilityTruthCheck(deps: {
  nowMs: number;
  thresholds: TruthThresholds;
  /** The next bucket on the rotation, or null when there is none. */
  nextBucket: () => Promise<{ code: string } | null>;
  /** What the bucket is currently OFFERING (slot starts) and how long a booking
   *  runs, or null when unreadable. Both come from one read: the window a slot
   *  occupies is what gets checked against Google, so a start with no duration
   *  cannot be verified at all. */
  cachedSlots: (code: string) => Promise<{ starts: string[]; durationMin: number } | null>;
  /** Emails of the bucket's eligible agents, or null when unreadable. */
  eligibleEmails: (code: string) => Promise<string[] | null>;
  /** Live verdict for one slot window across the whole eligible set. */
  verifySlot: (emails: string[], startIso: string, endIso: string) => Promise<SlotVerdict>;
  armed: boolean;
  cooldownMs: number;
  notify: (key: string, cooldownMs: number, text: string) => Promise<void>;
  resolve: (key: string, text: string) => Promise<boolean>;
  log?: (fields: Record<string, string | number | boolean | null | undefined>) => void;
  onError?: (context: "notify" | "resolve", err: unknown) => void;
}): Promise<TruthResult> {
  const skip = (why: string): TruthResult => {
    deps.log?.({ msg: "availability truth skipped", why });
    return { status: "skipped", why };
  };

  let bucket: { code: string } | null;
  try {
    bucket = await deps.nextBucket();
  } catch {
    return skip("rotation cursor unreadable");
  }
  if (!bucket) return skip("no bucket to probe");

  const offered = await deps.cachedSlots(bucket.code).catch(() => null);
  if (offered === null) return skip("slot payload unreadable");
  const sample = sampleSlotStarts(
    offered.starts,
    deps.nowMs,
    deps.thresholds.leadMs,
    deps.thresholds.sampleSize,
  );
  // Zero offered times is the empty-bucket condition, not a cache-integrity
  // fault, and the availability scan already pages on it.
  if (sample.length === 0) return skip("bucket is offering no times to check");

  const emails = await deps.eligibleEmails(bucket.code).catch(() => null);
  if (emails === null) return skip("eligible set unreadable");
  // Same again: nobody eligible makes every slot trivially unfree, which is the
  // empty-bucket page wearing this alert's name.
  if (emails.length === 0) return skip("bucket has no eligible agent");

  const durationMs = offered.durationMin * 60_000;
  const verdicts: SlotVerdict[] = [];
  for (const startIso of sample) {
    try {
      // parse-ok: fails CLOSED, twice over. sampleSlotStarts has already dropped
      // every start Date.parse could not read, so this cannot be NaN; and if one
      // ever did get through, NaN would make toISOString throw RangeError, which
      // the catch below records as "unverified" (the safe side) rather than as a
      // slot checked and found fine.
      const endIso = new Date(Date.parse(startIso) + durationMs).toISOString();
      verdicts.push(await deps.verifySlot(emails, startIso, endIso));
    } catch {
      // A Google failure tells us nothing about the cache, in either direction.
      verdicts.push("unverified");
    }
  }

  const summary = summarizeSample(verdicts);
  const verdict = judgeAvailabilityTruth(summary, deps.thresholds);
  const key = `${AVAILABILITY_TRUTH_ALERT_KEY}:${bucket.code}`;

  deps.log?.({
    msg: "availability truth",
    bucket: bucket.code,
    status: verdict.status,
    armed: deps.armed,
    sampled: sample.length,
    verified: summary.verified,
    drifted: summary.drifted,
    unverified: summary.unverified,
    drift_pct: summary.driftPct,
  });

  // Nothing was compared at all: report it as its own outcome rather than
  // letting a total Google outage read as an unverified SAMPLE.
  if (summary.verified === 0 && summary.unverified === sample.length) {
    return { status: "unverified", code: bucket.code };
  }

  if (deps.armed && verdict.status === "drifted") {
    await deps
      .notify(key, deps.cooldownMs, formatAvailabilityDriftAlert({ code: bucket.code, ...verdict }))
      .catch((err) => deps.onError?.("notify", err));
  }
  if (deps.armed && verdict.status === "healthy") {
    await deps
      .resolve(key, formatAvailabilityDriftAllClear({ code: bucket.code, verified: verdict.verified }))
      .catch((err) => deps.onError?.("resolve", err));
  }
  return { status: "checked", code: bucket.code, armed: deps.armed, verdict };
}
