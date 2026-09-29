/**
 * What /admin/alerts says about which low volume baseline is in force (#2739), per
 * debt tier (#2874).
 *
 * A pure builder, so every state is rendered by `scripts/test-volume-relearn.ts`
 * and the page holds no wording of its own (L41). Each state says what the alarm is
 * judging against NOW, positively, including on the day nothing is wrong (L610):
 * "the cal.com measurement is in force" is a fact a reader needs as much as "the
 * learned floors are in force", and "this tier is not judged" is one a reader needs
 * most of all, since an alarm that cannot fire reads exactly like a quiet one (L678).
 *
 * No `@/` imports, so node scripts can drive it.
 */
import { DateTime } from "luxon";
import { LEARNING, type LearnedFloors } from "./volume-learning.ts";
import { parseStampMs } from "../date/stamp.ts";
import { formatClockTime } from "../date/parse.ts";
import { REFIT_OVERDUE_MS, baselineInForce, type BaselineInForce } from "./volume-relearn.ts";
import { LOW_TIER, VOLUME_TIERS, tierLabel } from "./volume-tiers.ts";
import { MEASURED_VOLUME_BASELINE } from "./volume-baseline.ts";

/** The zone every date here is said in: the org's, which the measurement was judged in. */
const ZONE = MEASURED_VOLUME_BASELINE.zone;

/** "Oct 12, 2026" for a stored YYYY-MM-DD, read as a date rather than as UTC midnight. */
function day(iso: string): string {
  return DateTime.fromISO(iso, { zone: "UTC" }).toFormat("LLL d, yyyy");
}

/** "Oct 12, 2026" for a stored instant, on the day it fell in the org's zone. */
function dayOf(instantIso: string): string {
  return DateTime.fromISO(instantIso, { zone: ZONE }).toFormat("LLL d, yyyy");
}

/** "Oct 20 at 3:05pm Eastern", an instant in the org's zone. */
function instant(iso: string): string {
  const dt = DateTime.fromISO(iso, { zone: ZONE });
  const zoneName = ZONE === "America/New_York" ? "Eastern" : ZONE;
  return `${dt.toFormat("LLL d")} at ${formatClockTime(dt) ?? "an unknown time"} ${zoneName}`;
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** Where a tier's ramp started, in words: its first booking, or the later declared end. */
function rampStartWords(state: BaselineInForce): string {
  const e = state.entry;
  if (!e?.rampStartAt) return "";
  if (e.convertedFromRampEnd || !e.firstBookingAt) {
    return `the ramp end declared for ${dayOf(e.rampStartAt)}, recorded before Slate tracked each tier's first booking`;
  }
  const label = tierLabel(state.tier);
  return e.rampStartAt === e.firstBookingAt
    ? `the first real ${label} booking on ${dayOf(e.firstBookingAt)}`
    : `the ramp end declared for ${dayOf(e.rampStartAt)}`;
}

/** Weeks since the ramp start, from a stored insufficient result. */
function weeksSoFar(state: BaselineInForce): number {
  const r = state.entry?.result;
  return r && r.status === "insufficient" ? r.weeksSinceRamp : 0;
}

export interface LearningStatusCopy {
  /** Which baseline the alarm is judging against, as one sentence. */
  inForce: string;
  /** What that means and what happens next, one sentence per line. */
  detail: string[];
}

/** The Low tier's status, the tier with a cal.com measurement under it. */
export function learningStatusCopy(state: BaselineInForce, nowMs: number): LearningStatusCopy {
  if (state.kind === "learned") {
    // `baselineInForce` reports "learned" only for a result that carries floors.
    const r = state.entry.result as Extract<LearnedFloors, { status: "learned" | "declining" }>;
    const detail: string[] = [];
    if (r.status === "declining") {
      detail.push(
        `The last ${LEARNING.recentWeeks} weeks averaged ${plural(Math.round(r.recentPerWeek), "booking", "bookings")} a week ` +
          `against ${Math.round(r.earlierPerWeek).toLocaleString("en-US")} before them, so they were left out and the floors ` +
          `come from the earlier weeks. If traffic has moved for good, set a ramp end at the day it moved.`,
      );
    }
    detail.push(
      // The count and the span are on the floors section's own line already, from
      // the same baseline, so this says only what that line cannot (L605).
      `Left out of the fit: ${plural(r.excludedTest, "test booking", "test bookings")} and ` +
        `${plural(r.excludedRamp, "booking", "bookings")} from before the ramp started, at ${rampStartWords(state)}.`,
    );
    if (state.anchored) detail.push("No floor is below the cal.com measurement.");
    // An unreadable stamp reads as overdue, the side that sends somebody to look.
    const fittedMs = parseStampMs(state.fittedAt);
    if (fittedMs === null || nowMs - fittedMs > REFIT_OVERDUE_MS) {
      detail.push(
        `No refit has succeeded since ${instant(state.fittedAt)}, so the floors fitted then stay in force. ` +
          `The monitor's step failure alert for volume learning names the cause.`,
      );
    }
    const which = r.status === "declining" ? "learned from Slate's own bookings before a decline" : "learned from Slate's own bookings";
    return { inForce: `In force: floors ${which}, last refit ${instant(state.fittedAt)}.`, detail };
  }

  const measured =
    state.kind === "measured"
      ? `In force: the cal.com measurement from ${day(state.baseline.measuredOn)}.`
      : `Not judged: ${tierLabel(state.tier)} has no cal.com measurement and nothing learned yet.`;
  const label = tierLabel(state.tier);
  switch (state.why) {
    case "not-carried":
      return {
        inForce: measured,
        detail: [`Slate learns from its own bookings from the first real ${label} booking a landing page sends, which has not happened yet.`],
      };
    case "not-fitted":
      return {
        inForce: measured,
        detail: ["The first refit from Slate's own bookings runs on the next check, within 5 minutes."],
      };
    case "other-ramp-end":
      return {
        inForce: measured,
        detail: [
          state.rampEndOn
            ? `The ramp end is now ${day(state.rampEndOn)}. The refit for it runs on the next check, within 5 minutes.`
            : "The ramp end was cleared. The refit without it runs on the next check, within 5 minutes.",
        ],
      };
    case "insufficient": {
      const weeks = weeksSoFar(state);
      const when = state.fittedAt ? ` Checked ${instant(state.fittedAt)}.` : "";
      return {
        inForce: measured,
        detail: [
          `The ramp started at ${rampStartWords(state)}. Learning starts once ${LEARNING.minWeeks} full weeks have been booked after it, ` +
            `and ${weeks === 1 ? "1 has" : `${weeks} have`} passed so far.${when}`,
        ],
      };
    }
    case "unreadable":
      return {
        inForce: measured,
        detail: [
          "The stored refit could not be read, so the cal.com measurement stays in force until the next refit replaces it.",
        ],
      };
  }
}

/**
 * One line for every tier beside Low (#2874), each saying what is true of it now:
 * judged against its own learned floors, carried and not judged yet (with when it
 * will be), or not carried at all. Every tier gets a line, so a tier that is not
 * judged is stated rather than absent (L678).
 */
export function tierLearningLines(input: { rampEndOn: string | null; learning: unknown }, nowMs: number): string[] {
  return VOLUME_TIERS.filter((t) => t !== LOW_TIER).map((tier) => {
    const state = baselineInForce(input, tier);
    const label = tierLabel(tier);
    if (state.kind === "learned") {
      const fittedMs = parseStampMs(state.fittedAt);
      const overdue = fittedMs === null || nowMs - fittedMs > REFIT_OVERDUE_MS;
      return (
        `${label}: judged against floors learned from its own bookings since ${rampStartWords(state)}, ` +
        `with no cal.com measurement under them, last refit ${instant(state.fittedAt)}.` +
        (overdue ? " No refit has succeeded since then." : "")
      );
    }
    switch (state.why) {
      case "not-carried":
        return `${label}: no real booking yet, so not carried and not judged.`;
      case "insufficient": {
        const weeks = weeksSoFar(state);
        return (
          `${label}: carried since its first real booking on ${state.entry?.firstBookingAt ? dayOf(state.entry.firstBookingAt) : "an unknown day"}, and not judged until ${LEARNING.minWeeks} full weeks ` +
          `of its bookings are learned (${weeks === 1 ? "1 so far" : `${weeks} so far`}). Until then a drop in ${label} bookings is not caught.`
        );
      }
      case "not-fitted":
      case "other-ramp-end":
        return `${label}: not judged yet. The next refit, within 5 minutes, says whether Slate carries it.`;
      case "unreadable":
        return `${label}: the stored refit could not be read, so it is not judged until the next refit replaces it.`;
    }
  });
}
