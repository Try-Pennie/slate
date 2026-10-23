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
import { ANCHOR_OVERLAP_WEEKS, REFIT_OVERDUE_MS, baselineInForce, tierJudgedBaseline, type BaselineInForce } from "./volume-relearn.ts";
import { LOW_TIER, VOLUME_TIERS, tierLabel } from "./volume-tiers.ts";
import { CARRIED_SHARE, REAL_ANCHOR_SOURCE, type AnchorSource } from "./carried-share.ts";
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

const pct = (share: number) => `${Math.round(share * 100)}%`;

/**
 * What the stored share says about a tier (#2893), one sentence, or null when there
 * is nothing to say because the tier has no measurement to thin. Every outcome gets
 * its own words: a held share and a share measured today send a reader to do
 * different things (L11).
 */
export function shareSentence(state: BaselineInForce, source: AnchorSource = REAL_ANCHOR_SOURCE): string | null {
  if (!source.measurements[state.tier]?.length) return null;
  const label = tierLabel(state.tier);
  const sh = state.share;
  if (!sh) {
    return state.tier === LOW_TIER
      ? `Slate's share of ${label} bookings has not been measured yet, so the cal.com measurement stands as measured until the next refit measures it.`
      : `Slate's share of ${label} bookings has not been measured yet, so no cal.com measurement is under its floors.`;
  }
  const a = sh.applied;
  const inForce = a ? `${pct(a.share)} measured in the day to ${instant(a.to)}` : null;
  const counted = (slate: number, calcom: number) =>
    `${slate.toLocaleString("en-US")} of ${(slate + calcom).toLocaleString("en-US")} across Slate and cal.com`;
  switch (sh.last.outcome) {
    case "calcom-off":
      return `cal.com is not configured here, so Slate is taken to carry all of ${label} and its cal.com measurement applies in full.`;
    case "applied":
    case "hold-expired": {
      const base = `Slate carried ${pct(a!.share)} of ${label} bookings in the day to ${instant(a!.to)} (${counted(a!.slate, a!.calcom)}), so the cal.com floors under ${label} are thinned to that share.`;
      return sh.last.outcome === "hold-expired"
        ? `${base} It had been held for ${CARRIED_SHARE.holdExpiryDays} days, which is as long as a share is ever held.`
        : base;
    }
    case "held": {
      const until = sh.heldSince
        ? DateTime.fromISO(sh.heldSince, { zone: ZONE }).plus({ days: CARRIED_SHARE.holdExpiryDays }).toFormat("LLL d")
        : "the expiry";
      const level = sh.last.level === null ? "" : ` while ${label}'s whole traffic ran at ${pct(sh.last.level)} of its usual level`;
      return (
        `Slate's share of ${label} measured ${pct(sh.last.slate / Math.max(1, sh.last.slate + (sh.last.calcom ?? 0)))}${level}, ` +
        `which reads as bookings lost rather than moved to cal.com, so the ${inForce ?? "earlier share"} stays in force. ` +
        `It gives way on ${until} if it still holds then.`
      );
    }
    case "too-few":
    case "closed-day": {
      const why =
        sh.last.outcome === "too-few"
          ? `The last day had ${plural(sh.last.slate + (sh.last.calcom ?? 0), "booking", "bookings")} of ${label} across Slate and cal.com, too few to read a share from`
          : "The last day touched a day the office was closed, which says nothing about the share";
      return inForce
        ? `${why}, so the ${inForce} stays in force.`
        : `${why}, and no share has been measured yet.`;
    }
  }
}

/** The words for the floor under a tier's floors, at the share in force. */
function underWords(state: BaselineInForce, measuredOn: string): string {
  const a = state.share?.applied;
  const base = `its cal.com measurement from ${day(measuredOn)}`;
  return a && a.share < 1 ? `${base} thinned to the ${pct(a.share)} of ${tierLabel(state.tier)} bookings Slate carries` : base;
}

/**
 * The cal.com anchor's retirement (#3896), said ONCE for every tier, Low included, as
 * one sentence under the tier list (Dan's design round, 2026-10-23, "Once, under the
 * tiers"; docs/design/alerts-learning-retirement.html). Before the cutoff it says
 * when the measurement stops holding any floor up; after it, since when none has.
 * Null while cal.com is not marked retired. The tier lines and Low's status never
 * repeat it (L605). Retired is judged as the floors are, at the stored refit's own
 * fit time, through `baselineInForce`, so the sentence and the floors agree.
 */
export function anchorRetirementSentence(input: {
  rampEndOn: string | null;
  learning: unknown;
  calcomRetiredAt: string | null;
}): string | null {
  const state = baselineInForce(input, LOW_TIER);
  const r = state.anchorRetirement;
  if (!r) return null;
  if (state.anchorRetired) {
    return (
      `No cal.com measurement has held any floor up since ${dayOf(r.retiresAt)}, ${ANCHOR_OVERLAP_WEEKS} weeks after ` +
      `cal.com was marked retired, so every tier, Low included, follows Slate's own bookings.`
    );
  }
  return (
    `cal.com was marked retired on ${dayOf(r.calcomRetiredAt)}. From ${dayOf(r.retiresAt)}, ${ANCHOR_OVERLAP_WEEKS} weeks later, ` +
    `its measurement stops holding any floor up, and every tier, Low included, follows Slate's own bookings.`
  );
}

/**
 * What the ramp end confirm says about the cal.com floor under Low's floors (#3896),
 * from the same retirement state as `anchorRetirementSentence`, so it is true in every
 * state: plainly while cal.com is live, with the day it ends once cal.com is marked
 * retired, and null once the anchor has retired, when there is no such floor.
 */
export function rampEndLowFloorNote(input: {
  rampEndOn: string | null;
  learning: unknown;
  calcomRetiredAt: string | null;
}): string | null {
  const state = baselineInForce(input, LOW_TIER);
  const r = state.anchorRetirement;
  if (!r) return "Low's never go below the cal.com floors.";
  if (state.anchorRetired) return null;
  return `Low's never go below the cal.com floors before ${dayOf(r.retiresAt)}.`;
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
    if (state.anchored) detail.push("No floor is below the cal.com measurement, thinned to the share of Low Slate carries.");
    // The share only says how the anchor is thinned, so with the anchor retired it says
    // nothing; the retirement itself is said once under the tiers (#3896).
    const shared = state.anchorRetired ? null : shareSentence(state);
    if (shared) detail.push(shared);
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

  const notLearned = notLearnedCopy(state);
  const shared = shareSentence(state);
  return shared ? { ...notLearned, detail: [...notLearned.detail, shared] } : notLearned;
}

/** Low's status before it has learned: the measurement in force, and why nothing learned is. */
function notLearnedCopy(state: Exclude<BaselineInForce, { kind: "learned" }>): LearningStatusCopy {
  const measured =
    state.kind === "measured"
      ? `In force: ${underWords(state, state.baseline.measuredOn).replace(/^its /, "the ")}.`
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
 * will be), or not carried at all. A tier beside Low with a cal.com anchor, once its
 * carried share has been measured (#2893), says it is learning with that floor under
 * it, never that it is judged against it (#2888). Whether a tier is judged comes from `tierJudgedBaseline`, the
 * predicate the monitor's tier checks use, so the line and the alarm cannot disagree
 * (L16). Every tier gets a line, so a tier that is not judged is stated rather than
 * absent (L678).
 */
export function tierLearningLines(
  input: { rampEndOn: string | null; learning: unknown; calcomRetiredAt: string | null },
  nowMs: number,
  anchors: AnchorSource = REAL_ANCHOR_SOURCE,
): string[] {
  return VOLUME_TIERS.filter((t) => t !== LOW_TIER).map((tier) => {
    const state = baselineInForce(input, tier, anchors);
    const label = tierLabel(tier);
    if (state.kind === "learned") {
      const fittedMs = parseStampMs(state.fittedAt);
      const overdue = fittedMs === null || nowMs - fittedMs > REFIT_OVERDUE_MS;
      // #3896: once the anchor has retired the line says nothing about cal.com at all;
      // the one sentence under the tier list says since when, for every tier.
      const held =
        state.share?.last.outcome === "held" && !state.anchorRetired ? ` ${shareSentence(state, anchors)}` : "";
      const under = state.anchor
        ? `, none below ${underWords(state, state.anchor.measuredOn)}`
        : state.anchorRetired
          ? ""
          : ", with no cal.com measurement under them";
      return (
        `${label}: judged against floors learned from its own bookings since ${rampStartWords(state)}` +
        `${under}, last refit ${instant(state.fittedAt)}.` +
        (overdue ? " No refit has succeeded since then." : "") +
        held
      );
    }
    // The one predicate the monitor judges tiers by: a tier it returns nothing for is
    // never described as judged here (L16).
    if (tierJudgedBaseline(state) === null && state.kind === "measured" && state.why === "insufficient" && state.entry?.rampStartAt) {
      // Anchored and still learning (#2888, #2893): the measurement, thinned to the
      // share Slate carries, is a floor under what it learns, never what it is
      // judged against, so the line says it is learning.
      const weeks = weeksSoFar(state);
      return (
        `${label}: learning from its own bookings since its first real booking on ` +
        `${state.entry.firstBookingAt ? dayOf(state.entry.firstBookingAt) : "an unknown day"}, ` +
        `with ${underWords(state, state.baseline.measuredOn)} as the floor under what it learns. ` +
        `Not judged until ${LEARNING.minWeeks} full weeks are learned (${weeks === 1 ? "1 so far" : `${weeks} so far`}), ` +
        `so until then a drop in ${label} bookings is not caught.`
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
