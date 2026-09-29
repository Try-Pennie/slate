/**
 * Wiring the low volume learner (#1956 phase 2) to live data (#2739), per debt
 * tier (#2874).
 *
 * WHICH TIERS ARE CARRIED, AND FROM WHEN, IS DERIVED. Once a day the monitor lane
 * asks each tier for its first real page booking on or after the measurement date
 * (`EARLIEST_RAMP_END`). A tier with none is not carried, nothing is learned for it,
 * and it is recorded as looked at and found empty rather than left out, so "not
 * carried" and "never checked" read differently. A tier with one is carried from
 * that booking, which is its RAMP START: nobody has to declare anything, and
 * widening the pilot to a new tier needs no code change, no refit by hand and no
 * date typed anywhere.
 *
 * A DECLARED RAMP END (`monitor_alert_config.volume_ramp_end_on`, set on
 * /admin/alerts) is kept as the one human override, and it can only move a tier's
 * start LATER: a person who knows a tier's first weeks were a partial ramp says the
 * day it ended, and learning ignores the bookings before it (the trap
 * `volume-learning.ts` describes). A stored result belongs to the declaration it
 * was fitted under, so changing it takes every tier's result out of force and makes
 * a refit due at once.
 *
 * EACH TIER IS LEARNED FROM ITS OWN BOOKINGS ONLY, so one tier's traffic can never
 * move another's floors. The whole result is stored on one row (`volume_learning`),
 * one entry per tier, so a five minute tick costs one small read rather than a refit.
 *
 * A READ THAT FAILS LEAVES THE CURRENT FLOORS IN FORCE AND SAYS SO. Every failure
 * here THROWS: the lane's step boundary logs it and, after a few ticks, pages
 * `monitor_step_failing:volume_learning`. Nothing is written on the way, so the
 * stored result (or the cal.com measurement) stays exactly what the alarm judges
 * against, and the next tick retries, because a refit that did not land is still
 * due. The one thing a failure can never become is a fit over an empty list, which
 * would be a learned floor of zero (L105, L215).
 *
 * THE CAL.COM FIT IS THE FLOOR UNDER A MEASURED TIER'S LEARNED FLOOR TWICE:
 * `learnFloors` holds every cell at or above it when it fits, and `baselineInForce`
 * does again when it READS. A tier with no anchor (every tier beside Low, until
 * #2893) has nothing under it, and any tier beside Low is UNJUDGED until its own
 * traffic has been learned, and says so (`tierJudgedBaseline`).
 *
 * No `@/` imports, so node scripts can drive it directly.
 */
import { DateTime } from "luxon";
import { LEARNING, learnFloors, underpin, type LearnedFloors, type SlateBookingRow } from "./volume-learning.ts";
import type { VolumeBaseline } from "./volume-floors.ts";
import { MEASURED_VOLUME_BASELINE } from "./volume-baseline.ts";
import { parseStampMs } from "../date/stamp.ts";
import {
  LOW_TIER,
  TIER_ANCHORS,
  VOLUME_TIERS,
  isVolumeTier,
  recordOfTiers,
  tierLabel,
  tierRampStartMs,
  type VolumeTier,
} from "./volume-tiers.ts";

const HOUR_MS = 60 * 60_000;
const WEEK_MS = 7 * 24 * HOUR_MS;

/** How often the refit runs. */
export const REFIT_EVERY_MS = 24 * HOUR_MS;

/**
 * How old the last good refit may be before the admin page says refits are failing.
 * Two refits missed, so one slow day never reads as a fault.
 */
export const REFIT_OVERDUE_MS = 2 * REFIT_EVERY_MS;

/**
 * The stored shape's version. 2 is per tier (#2874); 1, a single result for Low, is
 * still READ (L1010: a stored version is never reinterpreted, only superseded) and
 * refit at once. Any other value is unreadable, never guessed at.
 */
export const LEARNING_STATE_VERSION = 2;

/** One tier's refit, as stored. */
export interface StoredTierLearning {
  /** The tier's first real page booking, as an ISO instant, or null: not carried. */
  firstBookingAt: string | null;
  /** When learning may start: the first booking or a later declared ramp end. Null when not carried. */
  rampStartAt: string | null;
  /** What was learned, or null when the tier is not carried. */
  result: LearnedFloors | null;
  /**
   * Set only on a version 1 result read back (never stored): its start is the
   * ramp end declared then, and nothing recorded the tier's first booking.
   */
  convertedFromRampEnd?: true;
}

/** What the lane writes to `monitor_alert_config.volume_learning`. */
export interface StoredVolumeLearning {
  version: typeof LEARNING_STATE_VERSION;
  /** The declared ramp end, YYYY-MM-DD, this refit ran under, or null for none. */
  declaredRampEndOn: string | null;
  /** When the refit ran, as an ISO instant. */
  fittedAt: string;
  /** One entry per tier the refit looked at. A tier with no entry was never fitted. */
  tiers: Partial<Record<VolumeTier, StoredTierLearning>>;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A YYYY-MM-DD that is a real calendar date. */
function isCalendarDate(s: string): boolean {
  return DATE_RE.test(s) && DateTime.fromISO(s, { zone: "UTC" }).isValid;
}

/** The start of the ramp end's day in `zone`, or null when it is not a real date. */
export function rampEndMs(rampEndOn: string, zone: string): number | null {
  if (!isCalendarDate(rampEndOn)) return null;
  const dt = DateTime.fromISO(`${rampEndOn}T00:00`, { zone });
  return dt.isValid ? dt.toMillis() : null;
}

const isCount = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
const isInstant = (s: unknown): s is string => typeof s === "string" && parseStampMs(s) !== null;

function isBaseline(b: unknown): b is VolumeBaseline {
  if (!b || typeof b !== "object") return false;
  const v = b as Record<string, unknown>;
  if (v.source !== "slate" && v.source !== "calcom") return false;
  for (const k of ["measuredOn", "fromDate", "toDate", "zone", "scope"]) if (typeof v[k] !== "string") return false;
  if (!isCount(v.bookings)) return false;
  if (v.tierShare !== null && !isCount(v.tierShare)) return false;
  // Every weekday and every hour, because a missing cell is a malformed record and
  // not a quiet hour: `floorsFor` would throw on it at the tick it was needed.
  if (!Array.isArray(v.cells) || v.cells.length !== 7) return false;
  return v.cells.every(
    (day) =>
      Array.isArray(day) &&
      day.length === 24 &&
      day.every((c) => c && typeof c === "object" && isCount(c.floor30) && isCount(c.floor120) && isCount(c.typical120)),
  );
}

function isResult(r: unknown): r is LearnedFloors {
  if (!r || typeof r !== "object") return false;
  const v = r as Record<string, unknown>;
  switch (v.status) {
    case "insufficient":
      return isCount(v.weeksSinceRamp) && isCount(v.needWeeks) && isCount(v.excludedTest) && isCount(v.excludedRamp);
    case "learned":
      return isBaseline(v.baseline) && isCount(v.excludedTest) && isCount(v.excludedRamp);
    case "declining":
      return (
        isBaseline(v.baseline) &&
        isCount(v.recentPerWeek) &&
        isCount(v.earlierPerWeek) &&
        isCount(v.excludedTest) &&
        isCount(v.excludedRamp)
      );
    default:
      // "not-started" is never stored: a tier is refit only once it has a ramp start.
      return false;
  }
}

function isTierEntry(e: unknown): e is StoredTierLearning {
  if (!e || typeof e !== "object") return false;
  const v = e as Record<string, unknown>;
  if (v.firstBookingAt === null) return v.rampStartAt === null && v.result === null;
  return isInstant(v.firstBookingAt) && isInstant(v.rampStartAt) && isResult(v.result);
}

export type StoredLearningRead =
  | { state: "none" }
  | { state: "unreadable" }
  /** `legacy` is a version 1 result, read as Low's and refit at the next tick. */
  | { state: "ok"; value: StoredVolumeLearning; legacy: boolean };

/**
 * The stored result, validated field by field (L688): the column is jsonb, so its
 * type is a claim nothing checked on the way in.
 */
export function readStoredLearning(raw: unknown): StoredLearningRead {
  if (raw === null || raw === undefined) return { state: "none" };
  if (typeof raw !== "object") return { state: "unreadable" };
  const v = raw as Record<string, unknown>;
  if (v.version === 1) {
    // #2739's single result, fitted for Low under a declared ramp end. It is judged
    // by the rules it was written under (L1013): Low's, under that declaration.
    if (typeof v.rampEndOn !== "string" || !isCalendarDate(v.rampEndOn)) return { state: "unreadable" };
    if (!isInstant(v.fittedAt) || !isResult(v.result)) return { state: "unreadable" };
    const startMs = rampEndMs(v.rampEndOn, MEASURED_VOLUME_BASELINE.zone);
    if (startMs === null) return { state: "unreadable" };
    return {
      state: "ok",
      legacy: true,
      value: {
        version: LEARNING_STATE_VERSION,
        declaredRampEndOn: v.rampEndOn,
        fittedAt: v.fittedAt,
        // It never knew the tier's first booking, only the declared ramp end, so it
        // records no first booking and says where its start came from, rather than
        // presenting the declared date as one.
        tiers: {
          [LOW_TIER]: {
            firstBookingAt: null,
            rampStartAt: new Date(startMs).toISOString(),
            result: v.result,
            convertedFromRampEnd: true,
          },
        },
      },
    };
  }
  if (v.version !== LEARNING_STATE_VERSION) return { state: "unreadable" };
  if (v.declaredRampEndOn !== null && (typeof v.declaredRampEndOn !== "string" || !isCalendarDate(v.declaredRampEndOn))) {
    return { state: "unreadable" };
  }
  if (!isInstant(v.fittedAt)) return { state: "unreadable" };
  if (!v.tiers || typeof v.tiers !== "object") return { state: "unreadable" };
  const tiers = v.tiers as Record<string, unknown>;
  // A key that is not a tier, or an entry that is not one, makes the whole record
  // unreadable: half a stored refit is not a smaller refit.
  if (Object.keys(tiers).length === 0) return { state: "unreadable" };
  for (const [tier, entry] of Object.entries(tiers)) {
    if (!isVolumeTier(tier) || !isTierEntry(entry)) return { state: "unreadable" };
  }
  return { state: "ok", legacy: false, value: raw as StoredVolumeLearning };
}

/** Why a tier has no learned floors yet. Only Low is judged against its cal.com measurement meanwhile; any other tier is not judged until it has learned (#2888). */
export type MeasuredWhy =
  /** The refit looked, and the tier has taken no real booking. */
  | "not-carried"
  /** No refit has run since this tier was looked at, or none has ever run. */
  | "not-fitted"
  /** The stored result was fitted under a different declared ramp end. */
  | "other-ramp-end"
  /** Carried, and not enough weeks after its ramp start yet. */
  | "insufficient"
  /** Something is stored and it is not a result. */
  | "unreadable";

interface InForceCommon {
  tier: VolumeTier;
  /** The declared ramp end now stored, or null. */
  rampEndOn: string | null;
  /** This tier's stored entry, when one is readable. */
  entry: StoredTierLearning | null;
  /** When the stored refit ran, when one is readable. */
  fittedAt: string | null;
}

export type BaselineInForce =
  /** Not yet learned: Low is judged against its cal.com measurement, any other tier is not judged (#2888). */
  | (InForceCommon & { kind: "measured"; baseline: VolumeBaseline; why: MeasuredWhy })
  /** A tier nobody has measured, not yet learned: nothing judges it. */
  | (InForceCommon & { kind: "unjudged"; why: MeasuredWhy })
  | (InForceCommon & {
      kind: "learned";
      /** Held at or above the anchor, cell by cell, where the tier has one. */
      baseline: VolumeBaseline;
      status: "learned" | "declining";
      entry: StoredTierLearning;
      fittedAt: string;
      /** False for a tier with no cal.com measurement under its learned floors. */
      anchored: boolean;
    });

/**
 * Which baseline one tier's low volume alarm judges against, from the stored ramp
 * end and the stored refit. The ONE judge of it: the monitor's floors and the admin
 * page's "in force" line both come from here, so they cannot disagree (L16).
 */
export function baselineInForce(
  input: { rampEndOn: string | null; learning: unknown },
  tier: VolumeTier,
  anchors: Readonly<Partial<Record<VolumeTier, VolumeBaseline>>> = TIER_ANCHORS,
): BaselineInForce {
  const { rampEndOn } = input;
  const anchor = anchors[tier] ?? null;
  const read = readStoredLearning(input.learning);
  const stored = read.state === "ok" ? read.value : null;
  const entry = stored?.tiers[tier] ?? null;
  const common: InForceCommon = { tier, rampEndOn, entry, fittedAt: stored?.fittedAt ?? null };
  const notLearned = (why: MeasuredWhy): BaselineInForce =>
    anchor ? { ...common, kind: "measured", baseline: anchor, why } : { ...common, kind: "unjudged", why };
  if (read.state === "unreadable") return notLearned("unreadable");
  if (!stored) return notLearned("not-fitted");
  if (stored.declaredRampEndOn !== rampEndOn) return notLearned("other-ramp-end");
  if (!entry) return notLearned("not-fitted");
  if (entry.rampStartAt === null) return notLearned("not-carried");
  const r = entry.result;
  if (!r || (r.status !== "learned" && r.status !== "declining")) return notLearned("insufficient");
  return {
    ...common,
    kind: "learned",
    baseline: anchor ? { ...r.baseline, cells: underpin(r.baseline.cells, anchor.cells) } : r.baseline,
    status: r.status,
    entry,
    fittedAt: stored.fittedAt,
    anchored: anchor !== null,
  };
}

/**
 * The floors a tier beside Low is judged against NOW, or null when it is not judged
 * (#2874, #2888). The ONE predicate for it: the monitor's tier checks and the admin
 * page's tier lines both come from here, so the page cannot say a tier is judged
 * while the alarm skips it, or the reverse (L16).
 *
 * A tier beside Low is judged only once four weeks of its own bookings are learned,
 * and then against those learned floors (held at or above an anchor, were it given
 * one; none has one until #2893). An anchor never makes a tier beside Low judged
 * before that: the pilot may move only some of a tier's pages, and judging that
 * partial traffic against floors fitted to the whole tier false pages, 108 to 283
 * times in two normal weeks as measured in `scripts/lib/volume-floor-scope.ts`. Low
 * is not decided here: it has its own check and is judged against its measurement
 * from the start, as it always has been.
 */
export function tierJudgedBaseline(state: BaselineInForce): VolumeBaseline | null {
  return state.kind === "learned" ? state.baseline : null;
}

export type RelearnResult =
  | { status: "not-due"; fittedAt: string }
  | { status: "refit"; rowsRead: number; tiers: Record<VolumeTier, LearnedFloors["status"] | "not-carried"> };

/**
 * The monitor lane's once a day refit. Every seam is injected so the rules are
 * driven by `scripts/test-volume-relearn.ts` with no database.
 *
 * Throws on anything it could not do: an unreadable ramp end, a failed read, an
 * answer about the tiers that leaves one out, a refused write. Each leaves the
 * stored floors exactly as they were.
 */
export async function runVolumeRelearn(deps: {
  nowMs: number;
  /** Each measured tier's cal.com fit, the floor under its learned floor. */
  anchors: Readonly<Partial<Record<VolumeTier, VolumeBaseline>>>;
  /** The zone weekday, hour and a declared ramp end's day are judged in. */
  zone: string;
  /** The stored ramp end and refit. Throws when it cannot be read. */
  readConfig: () => Promise<{ rampEndOn: string | null; learning: unknown }>;
  /**
   * Each tier's first real page booking at or after `sinceIso`, or null for a tier
   * nobody booked (`firstTierBookingsSince`). Throws on a failed read.
   */
  readFirstBookings: (sinceIso: string) => Promise<Record<VolumeTier, number | null>>;
  /** Every booking created in [since, until), test bookings flagged, each with its tier. Throws on a failed read. */
  readBookings: (sinceIso: string, untilIso: string) => Promise<SlateBookingRow[]>;
  /**
   * The dates the org records as CLOSED from `fromIsoDate` onward (#2764), through the
   * same exceptions loader the availability gate uses. Throws on a failed read: a
   * refit with the holidays left in is the fault this exists to prevent.
   */
  readClosedDates: (fromIsoDate: string) => Promise<string[]>;
  /** Store the refit. Throws when the write did not land. */
  save: (state: StoredVolumeLearning) => Promise<void>;
  log?: (fields: Record<string, unknown>) => void;
}): Promise<RelearnResult> {
  const { rampEndOn, learning } = await deps.readConfig();
  const declaredMs = rampEndOn ? rampEndMs(rampEndOn, deps.zone) : null;
  if (rampEndOn && declaredMs === null) throw new Error(`volume learning: the stored ramp end ${rampEndOn} is not a date`);

  const read = readStoredLearning(learning);
  if (read.state === "ok" && !read.legacy && read.value.declaredRampEndOn === rampEndOn) {
    // An unreadable stamp is due: refitting early costs a few reads, trusting a
    // stamp nobody can read would never refit at all.
    const fittedMs = parseStampMs(read.value.fittedAt);
    const age = fittedMs === null ? null : deps.nowMs - fittedMs;
    if (age !== null && age >= 0 && age < REFIT_EVERY_MS) return { status: "not-due", fittedAt: read.value.fittedAt };
  }

  // From the measurement's own date, the same cutoff the ramp end form enforces:
  // Slate carried no customer traffic before it, so nothing earlier starts a tier.
  const earliestMs = rampEndMs(EARLIEST_RAMP_END, deps.zone);
  if (earliestMs === null) throw new Error(`volume learning: the earliest ramp end ${EARLIEST_RAMP_END} is not a date`);
  const first = await deps.readFirstBookings(new Date(earliestMs).toISOString());
  for (const tier of VOLUME_TIERS) {
    const v = first[tier];
    // Silence about a tier is not "nobody booked it" (L214): refuse rather than
    // record a tier as not carried on an answer that never mentioned it.
    if (v === undefined || (v !== null && !Number.isFinite(v))) {
      throw new Error(`volume learning: the first bookings read said nothing readable about tier ${tier}`);
    }
  }
  const carried = VOLUME_TIERS.filter((t) => first[t] !== null);

  // A full horizon back, rather than from any ramp start, so the bookings before a
  // tier's start are READ and counted as excluded: the page says how many, and a
  // count of zero there means none existed rather than that none were looked at.
  const sinceMs = deps.nowMs - LEARNING.horizonWeeks * WEEK_MS;
  let rows: SlateBookingRow[] = [];
  let closedDates: string[] = [];
  if (carried.length > 0) {
    rows = await deps.readBookings(new Date(sinceMs).toISOString(), new Date(deps.nowMs).toISOString());
    closedDates = await deps.readClosedDates(DateTime.fromMillis(sinceMs, { zone: deps.zone }).toISODate() ?? "");
  }

  const tiers: Partial<Record<VolumeTier, StoredTierLearning>> = {};
  const summary: [VolumeTier, LearnedFloors["status"] | "not-carried"][] = [];
  for (const tier of VOLUME_TIERS) {
    const firstMs = first[tier] ?? null;
    const startMs = tierRampStartMs(firstMs, declaredMs);
    if (firstMs === null || startMs === null) {
      tiers[tier] = { firstBookingAt: null, rampStartAt: null, result: null };
      summary.push([tier, "not-carried"]);
      continue;
    }
    const result = learnFloors({
      // The tier's own rows, plus the test bucket rows, which belong to no tier
      // (their codes are not XBCs) and must still reach the learner so it counts
      // them as left out rather than their vanishing before any tier saw them.
      bookings: rows.filter((r) => r.tier === tier || (r.isTest && (r.tier ?? null) === null)),
      rampEndMs: startMs,
      nowMs: deps.nowMs,
      anchor: deps.anchors[tier] ?? null,
      zone: deps.zone,
      scope: `Every real ${tierLabel(tier)} booking a landing page sent Slate after the tier's ramp start`,
      closedDates,
    });
    tiers[tier] = { firstBookingAt: new Date(firstMs).toISOString(), rampStartAt: new Date(startMs).toISOString(), result };
    summary.push([tier, result.status]);
  }
  await deps.save({
    version: LEARNING_STATE_VERSION,
    declaredRampEndOn: rampEndOn,
    fittedAt: new Date(deps.nowMs).toISOString(),
    tiers,
  });
  deps.log?.({
    ramp_end: rampEndOn,
    rows_read: rows.length,
    closed_days: closedDates.length,
    carried: carried.join(",") || "none",
    tiers: summary.map(([t, status]) => `${t}=${status}`).join(" "),
  });
  return { status: "refit", rowsRead: rows.length, tiers: recordOfTiers(summary) };
}

/** The name the ramp end form's refusals carry back, so the page draws them beside it. */
export const RAMP_END_FORM = "volume-ramp-end";

/** The earliest ramp end the form accepts: the cal.com measurement's own date,
 *  read from the measurement so a refit of the baseline moves it too. */
export const EARLIEST_RAMP_END: string = MEASURED_VOLUME_BASELINE.measuredOn;

/** EARLIEST_RAMP_END as a reader sees it ("Sep 25, 2026"), derived so the refusal
 *  can never name a different cutoff from the one it enforces. */
export function earliestRampEndLabel(): string {
  return DateTime.fromISO(EARLIEST_RAMP_END, { zone: "UTC" }).toFormat("LLL d, yyyy");
}

export type RampEndFormResult = { ok: true; rampEndOn: string | null } | { ok: false; error: string };

/**
 * The ramp end form. Setting and clearing are two different presses, so a blank
 * date is refused on the set press rather than read as clearing: an empty field
 * that silently undid a declaration would be the quietest way to lose one.
 *
 * A date ahead of today is allowed. Learning then waits for it, and a ramp end is
 * easier to declare the day before than to remember the day after.
 */
export function parseRampEndForm(input: { intent: string; rampEnd: string }): RampEndFormResult {
  if (input.intent === "clear") return { ok: true, rampEndOn: null };
  if (input.intent !== "set") return { ok: false, error: "The ramp end form was sent without saying whether to set or clear it." };
  const d = (input.rampEnd ?? "").trim();
  if (!d) return { ok: false, error: "Pick the day the ramp ended." };
  if (!isCalendarDate(d)) return { ok: false, error: `${d} is not a date.` };
  if (d < EARLIEST_RAMP_END) {
    return {
      ok: false,
      error: `The ramp cannot have ended before ${earliestRampEndLabel()}: Slate carried no customer traffic before the cal.com measurement.`,
    };
  }
  return { ok: true, rampEndOn: d };
}
