/**
 * Judging the load run's latency against the day it ran on (#3258).
 *
 * The bar was a fixed 5s p95. On 2026-10-04 the 09-15 code, which passed that bar
 * on 09-15 at 3.5s, measured 7.0s on the same rig against a fresh throwaway branch,
 * and the three arm experiment that day measured 6.6s with the suspect removed. A
 * fixed bar was judging the throwaway environment more than the code: about 1.5s of
 * the median moved with the day on identical code.
 *
 * So a run now measures its own day. A BASELINE leg books a dozen times, one every
 * fifteen seconds, on the same deployment and branch just before the steady pass,
 * when nothing else is running. Its median is what one booking costs on that
 * environment at rest. The steady pass is then held to a MULTIPLE of it: the bar
 * asks how much the code degrades under sixty bookings a minute, which is the code's
 * property, and the environment cancels because both halves ran on it within
 * minutes of each other.
 *
 * What this does NOT judge, stated so nobody reads more into a pass: a change that
 * makes every booking slower at rest raises the baseline and the bar with it. The
 * ABSOLUTE 5s bar is therefore still reported on every run, met or missed, beside
 * the baseline median itself, so a slow day and a slow change are both visible.
 */
import type { DriverResult } from "./book-plan.ts";

/** How many bookings the baseline makes. Enough for a median that one slow answer cannot move. */
export const BASELINE_BOOKINGS = 12;
/** One every fifteen seconds: a booking takes three or four seconds on a slow day, so they never overlap. */
export const BASELINE_PER_MINUTE = 4;
/** Fewer successes than this and there is no median worth a bar: the run is incomplete. */
export const BASELINE_MIN_OK = 8;

/**
 * The steady p95 may be at most this multiple of the baseline median.
 *
 * PROVISIONAL, and the evidence for it is thin, which is why it is one named
 * constant. From the 2026-10-04 three arm run, with each arm's single at rest control
 * booking standing in for a baseline it did not yet have: recompute off, 6.6s over
 * 3.2s (2.1); the 09-15 code that day, 7.0s over a comparable rest. The suspect
 * on arm was 8.6s; at a rest of about 3.2s that is 2.7. 2.5 sits between the arm
 * that matched the 09-15 code and the arm with the regression. The first runs that
 * carry a real twelve booking baseline (main, and main with the #3258 fix) are what
 * should confirm or move it.
 */
export const LOAD_OVER_REST_RATIO_BAR = 2.5;

export type LatencyJudgement =
  | {
      kind: "relative";
      steadyP95: number;
      baselineP50: number;
      baselineOk: number;
      barMs: number;
      ratio: number;
      pass: boolean;
      absoluteBarMs: number;
      absoluteOver: boolean;
    }
  | { kind: "absolute"; steadyP95: number; absoluteBarMs: number; pass: boolean; why: string }
  | { kind: "unmeasured"; why: string };

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

/**
 * Which rule judges this run's latency, and its answer.
 *
 * - A baseline the run was configured for and did not deliver, or one with too few
 *   successes for a median, is `unmeasured`: the run is incomplete. Falling back to
 *   the absolute bar there would quietly change what a pass means mid run (L98).
 * - A run with no baseline leg (a hand run) keeps the absolute bar as the bar.
 */
export function judgeLatency(input: {
  steadyP95: number;
  absoluteBarMs: number;
  baseline: DriverResult | null | undefined;
  baselineExpected: boolean;
}): LatencyJudgement {
  const { steadyP95, absoluteBarMs } = input;
  if (!input.baselineExpected && !input.baseline) {
    return {
      kind: "absolute",
      steadyP95,
      absoluteBarMs,
      pass: steadyP95 <= absoluteBarMs,
      why: "no same day baseline ran, so the fixed bar is the bar",
    };
  }
  if (!input.baseline) {
    return { kind: "unmeasured", why: "the run was configured with a same day baseline and no baseline file arrived" };
  }
  const ok = input.baseline.attempts.filter((a) => a.status === 200).map((a) => a.wallMs);
  if (ok.length < BASELINE_MIN_OK) {
    return {
      kind: "unmeasured",
      why:
        `the same day baseline confirmed ${ok.length} of ${input.baseline.attempts.length} bookings, and a ` +
        `median needs at least ${BASELINE_MIN_OK}`,
    };
  }
  const baselineP50 = median(ok);
  const barMs = Math.round(baselineP50 * LOAD_OVER_REST_RATIO_BAR);
  return {
    kind: "relative",
    steadyP95,
    baselineP50,
    baselineOk: ok.length,
    barMs,
    ratio: baselineP50 > 0 ? steadyP95 / baselineP50 : Infinity,
    pass: steadyP95 <= barMs,
    absoluteBarMs,
    absoluteOver: steadyP95 > absoluteBarMs,
  };
}

/** The absolute bar as a reported figure, worded the same in the finding and the report. */
export function absoluteBarText(j: { steadyP95: number; absoluteBarMs: number }): string {
  return j.steadyP95 > j.absoluteBarMs
    ? `p95 ${j.steadyP95}ms is over the ${j.absoluteBarMs}ms absolute bar (reported, not the pass rule)`
    : `p95 ${j.steadyP95}ms is inside the ${j.absoluteBarMs}ms absolute bar`;
}

/** The report's one line on latency: which rule judged it, against what, and the absolute bar. */
export function latencyReportLine(j: LatencyJudgement): string {
  if (j.kind === "unmeasured") return `- latency: unjudged; ${j.why}`;
  if (j.kind === "absolute") {
    return `- latency: judged against the fixed ${j.absoluteBarMs}ms bar because ${j.why}; ${absoluteBarText(j)}`;
  }
  return (
    `- latency: same day baseline median ${j.baselineP50}ms over ${j.baselineOk} bookings at rest; the ` +
    `steady p95 of ${j.steadyP95}ms is ${j.ratio.toFixed(1)} times it, against a bar of ` +
    `${LOAD_OVER_REST_RATIO_BAR} times (${j.barMs}ms); ${absoluteBarText(j)}`
  );
}
