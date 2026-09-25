/**
 * What /admin/alerts says about which low volume baseline is in force (#2739).
 *
 * A pure builder, so every state is rendered by `scripts/test-volume-relearn.ts`
 * and the page holds no wording of its own (L41). Each state says what the alarm is
 * judging against NOW, positively, including on the day nothing is wrong (L610):
 * "the cal.com measurement is in force" is a fact a reader needs as much as "the
 * learned floors are in force".
 *
 * No `@/` imports, so node scripts can drive it.
 */
import { DateTime } from "luxon";
import { LEARNING, type LearnedFloors } from "./volume-learning.ts";
import { parseStampMs } from "../date/stamp.ts";
import { formatClockTime } from "../date/parse.ts";
import { REFIT_OVERDUE_MS, type BaselineInForce } from "./volume-relearn.ts";

/** "Oct 12, 2026" for a stored YYYY-MM-DD, read as a date rather than as UTC midnight. */
function day(iso: string): string {
  return DateTime.fromISO(iso, { zone: "UTC" }).toFormat("LLL d, yyyy");
}

/** "Oct 20 at 3:05pm Eastern", an instant in the baseline's own zone. */
function instant(iso: string, zone: string): string {
  const dt = DateTime.fromISO(iso, { zone });
  const zoneName = zone === "America/New_York" ? "Eastern" : zone;
  return `${dt.toFormat("LLL d")} at ${formatClockTime(dt) ?? "an unknown time"} ${zoneName}`;
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

export interface LearningStatusCopy {
  /** Which baseline the alarm is judging against, as one sentence. */
  inForce: string;
  /** What that means and what happens next, one sentence per line. */
  detail: string[];
}

export function learningStatusCopy(state: BaselineInForce, nowMs: number): LearningStatusCopy {
  const zone = state.baseline.zone;
  if (state.kind === "learned") {
    const s = state.stored;
    // `baselineInForce` reports "learned" only for a result that carries floors.
    const r = s.result as Extract<LearnedFloors, { status: "learned" | "declining" }>;
    const detail: string[] = [];
    if (r.status === "declining") {
      detail.push(
        `The last ${LEARNING.recentWeeks} weeks averaged ${plural(Math.round(r.recentPerWeek), "booking", "bookings")} a week ` +
          `against ${Math.round(r.earlierPerWeek).toLocaleString("en-US")} before them, so they were left out and the floors ` +
          `come from the earlier weeks. If traffic has moved for good, set the ramp end again.`,
      );
    }
    detail.push(
      // The count and the span are on the floors section's own line already, from
      // the same baseline, so this says only what that line cannot (L605).
      `Left out of the fit: ${plural(r.excludedTest, "test booking", "test bookings")} and ` +
        `${plural(r.excludedRamp, "booking", "bookings")} from before the ramp ended on ${day(s.rampEndOn)}.`,
    );
    detail.push("No floor is below the cal.com measurement.");
    // An unreadable stamp reads as overdue, the side that sends somebody to look.
    const fittedMs = parseStampMs(s.fittedAt);
    if (fittedMs === null || nowMs - fittedMs > REFIT_OVERDUE_MS) {
      detail.push(
        `No refit has succeeded since ${instant(s.fittedAt, zone)}, so the floors fitted then stay in force. ` +
          `The monitor's step failure alert for volume learning names the cause.`,
      );
    }
    const which = r.status === "declining" ? "learned from Slate's own bookings before a decline" : "learned from Slate's own bookings";
    return { inForce: `In force: floors ${which}, last refit ${instant(s.fittedAt, zone)}.`, detail };
  }

  const measured = `In force: the cal.com measurement from ${day(state.baseline.measuredOn)}.`;
  const ramp = state.rampEndOn ? day(state.rampEndOn) : "";
  switch (state.why) {
    case "no-ramp-end":
      return {
        inForce: measured,
        detail: ["Slate learns nothing from its own bookings until the day the ramp ended is set below."],
      };
    case "not-fitted":
    case "other-ramp-end":
      return {
        inForce: measured,
        detail: [`The ramp ended on ${ramp}. The first refit from Slate's own bookings runs on the next check, within 5 minutes.`],
      };
    case "insufficient": {
      const r = state.stored?.result;
      const weeks = r && r.status === "insufficient" ? r.weeksSinceRamp : 0;
      const when = state.stored ? ` Checked ${instant(state.stored.fittedAt, state.baseline.zone)}.` : "";
      return {
        inForce: measured,
        detail: [
          `The ramp ended on ${ramp}. Learning starts once ${LEARNING.minWeeks} full weeks have been booked after it, ` +
            `and ${weeks === 1 ? "1 has" : `${weeks} have`} passed so far.${when}`,
        ],
      };
    }
    case "unreadable":
      return {
        inForce: measured,
        detail: [
          `The ramp ended on ${ramp}, and the stored refit could not be read, so the cal.com measurement stays in force until the next refit replaces it.`,
        ],
      };
  }
}
