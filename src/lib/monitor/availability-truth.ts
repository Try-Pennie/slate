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

import type { AlertResolve, ThrottledNotify } from "./alert-deps";
import { bufferedWindow } from "../booking/buffered-window.ts";

/** alert_state key PREFIX. The code appends the bucket, so a second drifting
 *  bucket is not silenced by the first one's cooldown. */

export const AVAILABILITY_TRUTH_ALERT_KEY = "availability_drift";

/**
 * The code the ONE aggregate page rides on (`availability_drift:all`), so it
 * lives in the same throttled-alert family as the per-bucket pages and needs no
 * new catalog entry. Bucket codes are the 3-digit XBC codes, so this can never
 * collide with a real bucket or clear one's page by accident. Same trick, and
 * deliberately the same spelling, as the empty-bucket sweep's `AGGREGATE_BUCKET_CODE`.
 */
export const AGGREGATE_DRIFT_CODE = "all";

/**
 * How many buckets drifting at once stops being several faults and becomes one.
 *
 * Three, not the empty-bucket sweep's five, because the two conditions have
 * different base rates. A bucket can be empty for its own staffing reason, so
 * four at once is plausibly four causes. A drifted CACHE has essentially one
 * cause available to it: calendar sync or the push channels falling behind,
 * which hits every bucket at once. So the flood arrives sooner and carries less
 * per-bucket information when it does.
 */
export const AGGREGATE_DRIFT_THRESHOLD = 3;

/**
 * alert_state key PREFIX for the durable "this bucket was last measured
 * drifting" marker (#1373).
 *
 * The probe checks ONE bucket per tick, so unlike the empty-bucket sweep it
 * never sees the whole picture in one pass and cannot decide "is this
 * widespread" from what it just measured. The marker carries that across ticks.
 * It is NOT an alert: namespaced away from the cooldown keys so the two can
 * never collide, exactly as the lane watchdog's "first noticed missing" marker
 * is (#1102), and it needs no migration because `alert_state` is already a
 * generic key-to-timestamp table with deny-all RLS.
 *
 * Its freshness window IS the rotation: every bucket is re-measured once per
 * pass of the ladder, a measured healthy verdict deletes its marker, and only a
 * measured verdict touches one at all. So a marker can be at most one rotation
 * stale, and a tick that skipped or could not verify leaves the set untouched
 * rather than quietly emptying it.
 */
export const AVAILABILITY_TRUTH_SEEN_KEY = "availability_drift_seen";

/** What one sampled slot turned out to be. */
export type SlotVerdict =
  /** At least one eligible agent really is free: the offer is honest. */
  | "free"
  /** Every eligible agent read cleanly, and every one of them is busy. */
  | "drift"
  /** No free agent found, but at least one could not be read, so we cannot tell. */
  | "unverified";

export interface TruthThresholds {
  /** Skip slots closer than this: they are about to be verified on book anyway,
   *  and a booking landing mid-probe would read as drift. */
  leadMs: number;
  /**
   * Defensive ceiling on how many offered times one tick judges (#1381).
   *
   * NOT a sampling knob. Google's freeBusy is a range query, so the calendars
   * are read once per chunk however many slots there are, and the cost of a slot
   * is a local interval comparison. This exists only so a pathological payload
   * cannot run away with the CPU budget four cron lanes share, and it is set far
   * above any realistic horizon. When it does bite, the tick LOGS what it
   * dropped, because a silently truncated check reads as full coverage.
   */
  maxSlots: number;
  /** Below this many slots actually checked, there is no honest verdict. */
  minVerified: number;
  /** Drift share (percent of CHECKED slots) that must be EXCEEDED to page. */
  driftPct: number;
}

/** The part of `TruthThresholds` that decides which offered times get checked. */
export type SlotSampleSpec = Pick<TruthThresholds, "leadMs" | "maxSlots">;

/**
 * Every time the bucket is advertising that is worth checking, in time order.
 *
 * Not a sample (#1381). Google's freeBusy is a RANGE query, so reading the whole
 * horizon costs one call per calendar chunk whether we then judge five offered
 * times or five hundred; the per slot loop that made coverage look expensive was
 * a shape we chose, not one Google imposed. Checking a subset while reporting on
 * "availability" claimed more than it measured.
 *
 * Two filters survive, and both are real:
 *
 *  - the lead window, because a slot about to be verified on book anyway would
 *    read as drift if a booking landed on it mid probe;
 *  - an unreadable start, DROPPED rather than sorted, because `Date.parse` yields
 *    NaN and a NaN sort key would shuffle the list arbitrarily while looking like
 *    a normal result (#1169).
 *
 * The ceiling truncates from the FAR end, keeping the soonest times, since that
 * is where a stale cache costs a customer first.
 */
export function slotsToCheck(startsIso: string[], nowMs: number, spec: SlotSampleSpec): string[] {
  const floor = nowMs + spec.leadMs;
  return (
    startsIso
      // parse-ok: this is the site that REMOVES unreadable starts rather than
      // comparing them. The very next line drops every non-finite ms, which is why
      // an unreadable slot can never reach the list, the sort, or the live check.
      .map((iso) => ({ iso, ms: Date.parse(iso) }))
      .filter((s) => Number.isFinite(s.ms) && s.ms >= floor)
      .sort((a, b) => a.ms - b.ms)
      .slice(0, Math.max(0, spec.maxSlots))
      .map((s) => s.iso)
  );
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

/** What one tick should send, once its bucket has a measured verdict (#1373). */
export interface DriftAlertPlan {
  /** Every bucket believed to be drifting after this tick, in code order. */
  drifting: string[];
  /** True when the set is wide enough that one page replaces the per-bucket ones. */
  aggregated: boolean;
  /** Page this bucket on its own key, or null. */
  pageCode: string | null;
  /** Send the one aggregate page naming `drifting`. */
  aggregatePage: boolean;
  /** Per-bucket keys to drop with NO all-clear, superseded by the aggregate. */
  settleCodes: string[];
  /** Per-bucket key to all-clear normally, or null. */
  clearCode: string | null;
  /** Clear the aggregate page. */
  clearAggregate: boolean;
}

/**
 * Decide what one measured tick says, given who else is drifting (#1373).
 *
 * Dan asked for "one combined alert naming both buckets", and Slate already made
 * this call once for the same shape of problem: the empty-bucket sweep
 * aggregates deliberately, and its settings help says so. Two alerts on one
 * channel disagreeing about how to report a broad outage is one vocabulary to
 * the person reading them, whatever the code thinks (L89).
 *
 * The reason it aggregates at all: a drifted cache does not realistically go
 * wrong one bucket at a time. The cause is calendar sync or the push channels
 * falling behind, which hits every bucket at once, so the common case for this
 * alert IS the flood, and sixty identical lines carry no more information than
 * one naming the set.
 *
 * Two rules the branches exist to keep:
 *
 *  - A tick pages EITHER on its own key or through the aggregate, never both.
 *  - Every all-clear hangs off a MEASURED result. Only the bucket this tick
 *    actually checked leaves the set; a tick that skipped or could not verify
 *    never reaches here at all, so an unreadable rotation cannot empty the set
 *    and announce a recovery nobody measured (#1134).
 */
export function planDriftAlert(input: {
  /** The bucket this tick measured. */
  code: string;
  /** Its measured verdict: true = drifted, false = measured healthy. */
  drifted: boolean;
  /** Codes carrying a live drift marker BEFORE this tick's result. */
  seenDrifting: string[];
  /** Is the aggregate page currently firing? */
  aggregateFiring: boolean;
  /** Which per-bucket pages are currently firing. */
  perBucketFiring: string[];
  threshold: number;
}): DriftAlertPlan {
  const set = new Set(input.seenDrifting);
  if (input.drifted) set.add(input.code);
  else set.delete(input.code);
  const drifting = [...set].sort();
  const aggregated = drifting.length >= input.threshold;

  if (input.drifted) {
    return {
      drifting,
      aggregated,
      pageCode: aggregated ? null : input.code,
      aggregatePage: aggregated,
      // Only fold in pages that are actually firing. Settling a key that is not
      // firing would delete a cooldown row for nothing.
      settleCodes: aggregated ? [...input.perBucketFiring].sort() : [],
      clearCode: null,
      clearAggregate: false,
    };
  }

  // Measured healthy. The aggregate ends when the drift stops being widespread,
  // not only when it stops entirely: below the threshold the survivors go back
  // to paging individually, which is what the partial all-clear tells the reader.
  const clearAggregate = input.aggregateFiring && !aggregated;
  return {
    drifting,
    aggregated,
    pageCode: null,
    aggregatePage: false,
    settleCodes: [],
    // While the aggregate is firing this bucket's own page was folded in and is
    // not firing, so there is nothing to clear and saying so would be noise.
    clearCode: input.aggregateFiring ? null : input.code,
    clearAggregate,
  };
}

/** Cap on how many bucket codes an aggregate names. Sixty codes is a wall of
 *  text on the one screen where a reader is least patient with it. */
const MAX_NAMED_CODES = 8;

/**
 * The one page that replaces the per-bucket flood.
 *
 * It answers what a dozen identical lines could not: how widespread this is, and
 * therefore where to look. A truncated list SAYS it is truncated, because a
 * silently cut list reads as the whole set, and the count is always the true one
 * (L11: a message may claim only what its check measured).
 */
export function formatAvailabilityDriftAggregateAlert(input: {
  codes: string[];
  totalBuckets: number;
}): string {
  const named = input.codes.slice(0, MAX_NAMED_CODES).join(", ");
  const rest = input.codes.length - MAX_NAMED_CODES;
  const list = rest > 0 ? `${named} and ${rest} more` : named;
  return (
    `${input.codes.length} of ${input.totalBuckets} booking buckets are offering times ` +
    `that are not free: ${list}. Customers picking those times will be refused at the ` +
    `last step. This many at once points at calendar sync or the push channels falling ` +
    `behind rather than at any one bucket. Each bucket's own page is folded into this one.`
  );
}

/**
 * The all-clear for the aggregate (#1151: a condition owes the reader an end).
 *
 * Two genuinely different endings, and they must not read alike: every bucket is
 * honest again, or the drift is no longer widespread while some buckets are
 * still wrong and about to page on their own. Calling the second one "all clear"
 * would be the false-recovery defect (#1134).
 */
export function formatAvailabilityDriftAggregateAllClear(input: {
  stillDrifting: number;
  totalBuckets: number;
}): string {
  if (input.stillDrifting === 0) {
    return (
      `All ${input.totalBuckets} booking buckets are offering times that really are free ` +
      `again. The earlier page about drifted availability is cleared. No action is needed.`
    );
  }
  const what =
    input.stillDrifting === 1
      ? `1 of ${input.totalBuckets} buckets is`
      : `${input.stillDrifting} of ${input.totalBuckets} buckets are`;
  return (
    `The drifted availability across the booking buckets is no longer widespread, but ` +
    `${what} still offering times that are not free and will page individually from here. ` +
    `Customers picking those times are still refused at the last step.`
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
   *  runs, plus the gap kept either side of it, or null when unreadable. All come
   *  from one read: the window a slot occupies, gap included (#2991), is what
   *  gets checked against Google, so a start with no duration cannot be verified
   *  at all. */
  cachedSlots: (
    code: string,
  ) => Promise<{ starts: string[]; durationMin: number; bufferBeforeMin: number; bufferAfterMin: number } | null>;
  /** Emails of the bucket's eligible agents, or null when unreadable. */
  eligibleEmails: (code: string) => Promise<string[] | null>;
  /**
   * Live verdict for EVERY offered window, from ONE read of the eligible set's
   * calendars over the whole horizon (#1381), in the order given.
   *
   * Null when the read failed outright, which is different from a list of
   * `unverified`: null means nothing was compared at all. A short list is a
   * programming error rather than a partial answer, and is treated as a total
   * failure below rather than silently re-aligned with the wrong windows.
   */
  verifyWindows: (
    emails: string[],
    windows: { startIso: string; endIso: string }[],
  ) => Promise<SlotVerdict[] | null>;
  /**
   * Who else is drifting and what is already firing (#1373), or null when the
   * alert state could not be read. Null is NOT an empty set: an unread state
   * means this tick has measured nothing about how widespread the drift is.
   */
  alertContext: (code: string) => Promise<{
    seenDrifting: string[];
    perBucketFiring: string[];
    aggregateFiring: boolean;
    totalBuckets: number;
  } | null>;
  /** Record or drop this bucket's durable "measured drifting" marker. */
  markDrifting: (code: string, drifting: boolean) => Promise<void>;
  /** Drop the per-bucket pages the aggregate supersedes, with no all-clear each. */
  settleSilently: (codes: string[]) => Promise<void>;
  armed: boolean;
  cooldownMs: number;
  notify: ThrottledNotify;
  resolve: AlertResolve;
  log?: (fields: Record<string, string | number | boolean | null | undefined>) => void;
  onError?: (context: "notify" | "resolve" | "mark" | "settle", err: unknown) => void;
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
  const sample = slotsToCheck(offered.starts, deps.nowMs, deps.thresholds);
  // Zero offered times is the empty-bucket condition, not a cache-integrity
  // fault, and the availability scan already pages on it.
  if (sample.length === 0) return skip("bucket is offering no times to check");

  const emails = await deps.eligibleEmails(bucket.code).catch(() => null);
  if (emails === null) return skip("eligible set unreadable");
  // Same again: nobody eligible makes every slot trivially unfree, which is the
  // empty-bucket page wearing this alert's name.
  if (emails.length === 0) return skip("bucket has no eligible agent");

  const durationMs = offered.durationMin * 60_000;
  const windows = sample.map((startIso) => {
    // parse-ok: slotsToCheck has already dropped every start Date.parse could
    // not read, so this cannot be NaN. If one ever did get through, NaN would
    // make toISOString throw RangeError, which the catch below turns into a
    // total failure (the safe side) rather than a slot checked and found fine.
    const endIso = new Date(Date.parse(startIso) + durationMs).toISOString();
    // #2991: the gap either side of the call is part of what was offered, so a
    // meeting sitting in it is drift, exactly as the booker would judge it.
    const [fromIso, toIso] = bufferedWindow(
      { buffer_before_min: offered.bufferBeforeMin, buffer_after_min: offered.bufferAfterMin },
      startIso,
      endIso,
    );
    return { startIso: fromIso, endIso: toIso };
  });

  const verdicts = await deps.verifyWindows(emails, windows).catch(() => null);
  // A read that failed outright, or came back the wrong length, has compared
  // NOTHING. Padding it out to the right size would put a real verdict against
  // the wrong window, which is worse than admitting we do not know.
  if (verdicts === null || verdicts.length !== windows.length) {
    deps.log?.({
      msg: "availability truth",
      bucket: bucket.code,
      status: "unverified",
      armed: deps.armed,
      offered: offered.starts.length,
      checked: 0,
    });
    return { status: "unverified", code: bucket.code };
  }

  const summary = summarizeSample(verdicts);
  const verdict = judgeAvailabilityTruth(summary, deps.thresholds);
  const key = `${AVAILABILITY_TRUTH_ALERT_KEY}:${bucket.code}`;

  deps.log?.({
    msg: "availability truth",
    bucket: bucket.code,
    status: verdict.status,
    armed: deps.armed,
    // `offered` beside `checked` so a truncated tick is visible rather than
    // reading as full coverage. They differ only by the lead window, an
    // unreadable start, or the defensive ceiling biting.
    offered: offered.starts.length,
    checked: sample.length,
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

  // An `unverified` verdict measured nothing, so it leaves the drifting set
  // exactly as it found it. Only the two MEASURED outcomes below touch a marker
  // or say anything, which is what stops an unreadable rotation from quietly
  // emptying the set and announcing a recovery nobody observed (#1134).
  if (verdict.status === "unverified") {
    return { status: "checked", code: bucket.code, armed: deps.armed, verdict };
  }
  const drifted = verdict.status === "drifted";

  // The marker is state, not an alert, so it is kept current even while the page
  // is disarmed (#1371). Arming a probe whose set started empty would under
  // report how widespread the drift already was.
  await deps.markDrifting(bucket.code, drifted).catch((err) => deps.onError?.("mark", err));

  const context = await deps.alertContext(bucket.code).catch(() => null);
  const plan = planDriftAlert({
    code: bucket.code,
    drifted,
    seenDrifting: context?.seenDrifting ?? [],
    aggregateFiring: context?.aggregateFiring ?? false,
    perBucketFiring: context?.perBucketFiring ?? [],
    // An unread state cannot support the aggregate call, so it is forced past the
    // threshold's reach. The tick then pages per bucket, which is the safe way to
    // be wrong: a flood beats silence while something is genuinely broken.
    threshold: context === null ? Number.POSITIVE_INFINITY : AGGREGATE_DRIFT_THRESHOLD,
  });

  deps.log?.({
    msg: "availability drift alerting",
    bucket: bucket.code,
    aggregated: plan.aggregated,
    drifting: plan.drifting.length,
    state_read: context !== null,
  });

  if (deps.armed) {
    if (plan.settleCodes.length > 0) {
      await deps
        .settleSilently(plan.settleCodes.map((c) => `${AVAILABILITY_TRUTH_ALERT_KEY}:${c}`))
        .catch((err) => deps.onError?.("settle", err));
    }
    if (plan.aggregatePage) {
      await deps
        .notify(
          `${AVAILABILITY_TRUTH_ALERT_KEY}:${AGGREGATE_DRIFT_CODE}`,
          deps.cooldownMs,
          formatAvailabilityDriftAggregateAlert({
            codes: plan.drifting,
            totalBuckets: context?.totalBuckets ?? plan.drifting.length,
          }),
        )
        .catch((err) => deps.onError?.("notify", err));
    }
    if (plan.pageCode !== null && verdict.status === "drifted") {
      await deps
        .notify(key, deps.cooldownMs, formatAvailabilityDriftAlert({ code: plan.pageCode, ...verdict }))
        .catch((err) => deps.onError?.("notify", err));
    }
    // Both all-clears hang off a MEASURED healthy sample AND a state we could
    // read. `context === null` means we do not know what is still drifting, and
    // a recovery notice is exactly the claim that must not be made on a guess.
    if (context !== null && plan.clearAggregate) {
      await deps
        .resolve(
          `${AVAILABILITY_TRUTH_ALERT_KEY}:${AGGREGATE_DRIFT_CODE}`,
          formatAvailabilityDriftAggregateAllClear({
            stillDrifting: plan.drifting.length,
            totalBuckets: context.totalBuckets,
          }),
        )
        .catch((err) => deps.onError?.("resolve", err));
    }
    if (context !== null && plan.clearCode !== null && verdict.status === "healthy") {
      await deps
        .resolve(key, formatAvailabilityDriftAllClear({ code: plan.clearCode, verified: verdict.verified }))
        .catch((err) => deps.onError?.("resolve", err));
    }
  }
  return { status: "checked", code: bucket.code, armed: deps.armed, verdict };
}
