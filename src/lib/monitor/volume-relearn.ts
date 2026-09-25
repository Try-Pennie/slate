/**
 * Wiring the low volume learner (#1956 phase 2) to live data (#2739).
 *
 * THE RAMP END IS A STORED DATE A PERSON SETS on /admin/alerts
 * (`monitor_alert_config.volume_ramp_end_on`), empty by default. Until it is set,
 * nothing here reads a booking, nothing is written, and the floors in force are the
 * cal.com measurement. That is the whole reason it is a declaration rather than a
 * date computed from traffic: during the ramp Slate deliberately carries a fraction
 * of the traffic, and nothing in the data can say when that stopped (see
 * `volume-learning.ts`).
 *
 * ONCE IT IS SET, the monitor lane refits once a day (`REFIT_EVERY_MS`) from
 * Slate's own bookings and stores the whole result on the same row
 * (`volume_learning`), so a five minute tick costs one small read rather than a
 * refit. A stored result belongs to the ramp end it was fitted for: changing the
 * date takes it out of force and makes a refit due at once.
 *
 * A READ THAT FAILS LEAVES THE CURRENT FLOORS IN FORCE AND SAYS SO. Every failure
 * here THROWS: the lane's step boundary logs it and, after a few ticks, pages
 * `monitor_step_failing:volume_learning`. Nothing is written on the way, so the
 * stored result (or the cal.com measurement) stays exactly what the alarm judges
 * against, and the next tick retries, because a refit that did not land is still
 * due. The one thing a failure can never become is a fit over an empty list, which
 * would be a learned floor of zero (L105, L215).
 *
 * THE CAL.COM FIT IS THE FLOOR UNDER THE LEARNED FLOOR TWICE: `learnFloors` holds
 * every cell at or above it when it fits, and `baselineInForce` does again when it
 * READS, so a stored result from before a re-measurement, or one damaged on the
 * way, can still never judge below the measured floors.
 *
 * No `@/` imports, so node scripts can drive it directly.
 */
import { DateTime } from "luxon";
import { LEARNING, learnFloors, underpin, type LearnedFloors, type SlateBookingRow } from "./volume-learning.ts";
import type { VolumeBaseline } from "./volume-floors.ts";
import { MEASURED_VOLUME_BASELINE } from "./volume-baseline.ts";
import { parseStampMs } from "../date/stamp.ts";

const HOUR_MS = 60 * 60_000;
const WEEK_MS = 7 * 24 * HOUR_MS;

/** How often a declared ramp end is refit. */
export const REFIT_EVERY_MS = 24 * HOUR_MS;

/**
 * How old the last good refit may be before the admin page says refits are failing.
 * Two refits missed, so one slow day never reads as a fault.
 */
export const REFIT_OVERDUE_MS = 2 * REFIT_EVERY_MS;

/** The stored shape's version. A stored value naming another is unreadable, never guessed at. */
export const LEARNING_STATE_VERSION = 1;

/** What the lane writes to `monitor_alert_config.volume_learning`. */
export interface StoredVolumeLearning {
  version: typeof LEARNING_STATE_VERSION;
  /** The ramp end, YYYY-MM-DD, this result was fitted for. */
  rampEndOn: string;
  /** When the refit ran, as an ISO instant. */
  fittedAt: string;
  result: LearnedFloors;
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
      // "not-started" is never stored: the lane does not refit without a ramp end.
      return false;
  }
}

export type StoredLearningRead =
  | { state: "none" }
  | { state: "unreadable" }
  | { state: "ok"; value: StoredVolumeLearning };

/**
 * The stored result, validated field by field (L688): the column is jsonb, so its
 * type is a claim nothing checked on the way in.
 */
export function readStoredLearning(raw: unknown): StoredLearningRead {
  if (raw === null || raw === undefined) return { state: "none" };
  if (typeof raw !== "object") return { state: "unreadable" };
  const v = raw as Record<string, unknown>;
  if (v.version !== LEARNING_STATE_VERSION) return { state: "unreadable" };
  if (typeof v.rampEndOn !== "string" || !isCalendarDate(v.rampEndOn)) return { state: "unreadable" };
  if (typeof v.fittedAt !== "string" || !Number.isFinite(Date.parse(v.fittedAt))) return { state: "unreadable" };
  if (!isResult(v.result)) return { state: "unreadable" };
  return { state: "ok", value: raw as StoredVolumeLearning };
}

/** Why the cal.com measurement is the baseline in force. */
export type MeasuredWhy =
  /** Nobody has declared the ramp over. */
  | "no-ramp-end"
  /** Declared, and no refit has landed yet. */
  | "not-fitted"
  /** The stored result was fitted for a different ramp end. */
  | "other-ramp-end"
  /** Declared, and not enough weeks after it yet. */
  | "insufficient"
  /** Something is stored and it is not a result. */
  | "unreadable";

export type BaselineInForce =
  | {
      kind: "measured";
      baseline: VolumeBaseline;
      why: MeasuredWhy;
      rampEndOn: string | null;
      /** The stored result it did not use, when one is readable. */
      stored: StoredVolumeLearning | null;
    }
  | {
      kind: "learned";
      /** Held at or above the anchor, cell by cell. */
      baseline: VolumeBaseline;
      status: "learned" | "declining";
      rampEndOn: string;
      stored: StoredVolumeLearning;
    };

/**
 * Which baseline the low volume alarm judges against, from the stored ramp end and
 * the stored refit. The ONE judge of it: the monitor's floors and the admin page's
 * "in force" line both come from here, so they cannot disagree (L16).
 */
export function baselineInForce(
  input: { rampEndOn: string | null; learning: unknown },
  anchor: VolumeBaseline,
): BaselineInForce {
  const { rampEndOn } = input;
  const read = readStoredLearning(input.learning);
  const stored = read.state === "ok" ? read.value : null;
  const measured = (why: MeasuredWhy): BaselineInForce => ({ kind: "measured", baseline: anchor, why, rampEndOn, stored });
  if (!rampEndOn) return measured("no-ramp-end");
  if (read.state === "unreadable") return measured("unreadable");
  if (!stored) return measured("not-fitted");
  if (stored.rampEndOn !== rampEndOn) return measured("other-ramp-end");
  const r = stored.result;
  if (r.status !== "learned" && r.status !== "declining") return measured("insufficient");
  return {
    kind: "learned",
    baseline: { ...r.baseline, cells: underpin(r.baseline.cells, anchor.cells) },
    status: r.status,
    rampEndOn,
    stored,
  };
}

export type RelearnResult =
  | { status: "no-ramp-end" }
  | { status: "not-due"; fittedAt: string }
  | { status: "refit"; learned: LearnedFloors["status"]; rowsRead: number };

/**
 * The monitor lane's once a day refit. Every seam is injected so the rules are
 * driven by `scripts/test-volume-relearn.ts` with no database.
 *
 * Throws on anything it could not do: an unreadable ramp end, a failed bookings
 * read, a refused write. Each leaves the stored floors exactly as they were.
 */
export async function runVolumeRelearn(deps: {
  nowMs: number;
  /** The cal.com fit, the floor under every learned floor. */
  anchor: VolumeBaseline;
  /** The stored ramp end and refit. Throws when it cannot be read. */
  readConfig: () => Promise<{ rampEndOn: string | null; learning: unknown }>;
  /** Every booking created in [since, until), test bookings flagged. Throws on a failed read. */
  readBookings: (sinceIso: string, untilIso: string) => Promise<SlateBookingRow[]>;
  /** Store the refit. Throws when the write did not land. */
  save: (state: StoredVolumeLearning) => Promise<void>;
  log?: (fields: Record<string, unknown>) => void;
}): Promise<RelearnResult> {
  const { rampEndOn, learning } = await deps.readConfig();
  if (!rampEndOn) return { status: "no-ramp-end" };
  const rampMs = rampEndMs(rampEndOn, deps.anchor.zone);
  if (rampMs === null) throw new Error(`volume learning: the stored ramp end ${rampEndOn} is not a date`);

  const read = readStoredLearning(learning);
  if (read.state === "ok" && read.value.rampEndOn === rampEndOn) {
    // An unreadable stamp is due: refitting early costs one read, trusting a stamp
    // nobody can read would never refit at all.
    const fittedMs = parseStampMs(read.value.fittedAt);
    const age = fittedMs === null ? null : deps.nowMs - fittedMs;
    if (age !== null && age >= 0 && age < REFIT_EVERY_MS) return { status: "not-due", fittedAt: read.value.fittedAt };
  }

  // A full horizon back, rather than from the ramp end, so the bookings before it
  // are READ and counted as excluded: the page says how many, and a count of zero
  // there means none existed rather than that none were looked at.
  const sinceMs = deps.nowMs - LEARNING.horizonWeeks * WEEK_MS;
  const rows = await deps.readBookings(new Date(sinceMs).toISOString(), new Date(deps.nowMs).toISOString());
  const result = learnFloors({ bookings: rows, rampEndMs: rampMs, nowMs: deps.nowMs, anchor: deps.anchor });
  await deps.save({
    version: LEARNING_STATE_VERSION,
    rampEndOn,
    fittedAt: new Date(deps.nowMs).toISOString(),
    result,
  });
  deps.log?.({
    ramp_end: rampEndOn,
    rows_read: rows.length,
    learned: result.status,
    ...(result.status === "not-started"
      ? {}
      : { excluded_test: result.excludedTest, excluded_ramp: result.excludedRamp }),
  });
  return { status: "refit", learned: result.status, rowsRead: rows.length };
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
