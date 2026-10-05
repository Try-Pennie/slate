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
/** Fewer successes than this and there is no median worth a bar: the speed verdict is void. */
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
 * What the judge entry found in the results directory for the baseline (#3258).
 * Four answers, because each sends a reader somewhere different (L11): none
 * arrived, two or more arrived (taking the first silently would judge the day by
 * whichever the directory listed first), one could not be parsed, or one usable file.
 */
export type BaselineReading =
  | { kind: "file"; result: DriverResult }
  | { kind: "absent" }
  | { kind: "several"; files: string[] }
  | { kind: "unreadable"; file: string; why: string }
  /** The results directory itself could not be listed, so nothing was looked at. */
  | { kind: "unlisted"; why: string };

/**
 * What is wrong with a parsed baseline's shape, or null when the judge can use it
 * (#3294 review). Every field the latency rule reads is checked, so a malformed file
 * is reported as unreadable rather than cast blind and crashing the judge.
 */
function baselineShapeProblem(parsed: unknown): string | null {
  const f = parsed as { runId?: unknown; attempts?: unknown };
  if (typeof f.runId !== "string") return "it carries no runId string";
  if (!Array.isArray(f.attempts)) return "its attempts field is not a list";
  for (const [i, a] of f.attempts.entries()) {
    const at = a as { status?: unknown; wallMs?: unknown } | null;
    if (typeof at?.status !== "number") return `attempt ${i} has no numeric status`;
    if (typeof at?.wallMs !== "number" || !Number.isFinite(at.wallMs)) return `attempt ${i} has no finite wallMs`;
  }
  return null;
}

/**
 * The reading from every result file the judge gathered. A file counts as the
 * baseline when it SAYS mode baseline, or when it is named like one and cannot be
 * parsed: a corrupt `baseline.json` is an unreadable baseline, never an absent one.
 */
export function baselineReading(
  files: { name: string; parsed?: unknown; error?: string }[],
  /** Set when the results directory could not be listed at all (L11). */
  listingError?: string,
): BaselineReading {
  if (listingError !== undefined) return { kind: "unlisted", why: listingError };
  const corrupt = files.find((f) => f.error !== undefined && /^baseline.*\.json$/.test(f.name));
  if (corrupt) return { kind: "unreadable", file: corrupt.name, why: corrupt.error! };
  const found = files.filter(
    (f) =>
      f.error === undefined &&
      typeof f.parsed === "object" &&
      f.parsed !== null &&
      (f.parsed as { mode?: unknown }).mode === "baseline",
  );
  if (found.length > 1) return { kind: "several", files: found.map((f) => f.name) };
  if (found.length === 0) return { kind: "absent" };
  const only = found[0]!;
  const problem = baselineShapeProblem(only.parsed);
  if (problem !== null) return { kind: "unreadable", file: only.name, why: problem };
  return { kind: "file", result: only.parsed as DriverResult };
}

/**
 * Which rule judges this run's latency, and its answer.
 *
 * - A run with no baseline leg (a hand run) keeps the absolute bar as the bar.
 * - A baseline the run was configured for that is missing, doubled, unreadable,
 *   from another run, or too thin for a median is `unmeasured`. Dan, 2026-10-05:
 *   that voids the SPEED verdict only; every other bar is still judged, and the
 *   speed result is reported as unmeasured, never as a pass and never as the fixed
 *   bar quietly standing in for the rule the run was configured with (L98).
 */
export function judgeLatency(input: {
  steadyP95: number;
  absoluteBarMs: number;
  baseline: BaselineReading | undefined;
  baselineExpected: boolean;
  runId: string;
}): LatencyJudgement {
  const { steadyP95, absoluteBarMs } = input;
  const reading = input.baseline ?? { kind: "absent" as const };
  if (!input.baselineExpected && reading.kind === "absent") {
    return {
      kind: "absolute",
      steadyP95,
      absoluteBarMs,
      pass: steadyP95 <= absoluteBarMs,
      why: "no same day baseline ran, so the fixed bar is the bar",
    };
  }
  if (reading.kind === "absent") {
    return { kind: "unmeasured", why: "no baseline file arrived, though the run was configured with a same day baseline" };
  }
  if (reading.kind === "several") {
    return {
      kind: "unmeasured",
      why: `${reading.files.length} baseline files arrived (${reading.files.join(", ")}), so which one measured the day cannot be told`,
    };
  }
  if (reading.kind === "unlisted") {
    return { kind: "unmeasured", why: `the results directory could not be listed (${reading.why}), so no baseline was looked for` };
  }
  if (reading.kind === "unreadable") {
    return { kind: "unmeasured", why: `the baseline file ${reading.file} could not be read (${reading.why})` };
  }
  const baseline = reading.result;
  if (baseline.runId !== input.runId) {
    return { kind: "unmeasured", why: `the baseline file is from run ${baseline.runId}, not ${input.runId}` };
  }
  const ok = baseline.attempts.filter((a) => a.status === 200).map((a) => a.wallMs);
  if (ok.length < BASELINE_MIN_OK) {
    return {
      kind: "unmeasured",
      why:
        `the same day baseline confirmed ${ok.length} of ${baseline.attempts.length} bookings, and a ` +
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
  if (j.kind === "unmeasured") return `- latency: UNMEASURED, so the speed verdict is void and every other bar was judged; ${j.why}`;
  if (j.kind === "absolute") {
    return `- latency: judged against the fixed ${j.absoluteBarMs}ms bar because ${j.why}; ${absoluteBarText(j)}`;
  }
  return (
    `- latency: same day baseline median ${j.baselineP50}ms over ${j.baselineOk} bookings at rest; the ` +
    `steady p95 of ${j.steadyP95}ms is ${j.ratio.toFixed(1)} times it, against a bar of ` +
    `${LOAD_OVER_REST_RATIO_BAR} times (${j.barMs}ms); ${absoluteBarText(j)}`
  );
}

/**
 * The report's verdict line (#3258). Every unmeasured cause is NAMED in the line,
 * beside the verdict, and a pass is claimed only for bars that were actually judged
 * (L11, L98): when the platform reading was unmeasured too, its bars were never
 * judged, so "every other bar passed" would be false.
 */
export function verdictText(r: {
  verdict: string;
  speedUnmeasured: string | null;
  platformUnmeasured: string | null;
}): string {
  const head = `Verdict: **${r.verdict.toUpperCase()}**`;
  const causes = [
    ...(r.speedUnmeasured !== null ? [`speed was UNMEASURED because ${r.speedUnmeasured}`] : []),
    ...(r.platformUnmeasured !== null ? [`platform limits were UNMEASURED because ${r.platformUnmeasured}`] : []),
  ];
  if (causes.length === 0) return `${head}.`;
  if (r.verdict === "fail") return `${head}; also, ${causes.join("; and ")}.`;
  // Unmeasured with nothing failed: claim a pass only for what was judged.
  const judged = r.platformUnmeasured === null ? "every other bar passed" : "the bars that were judged passed";
  return `${head}: ${judged}, and ${causes.join("; and ")}.`;
}

/**
 * Whether the judge was told the run carried a same day baseline (#3294 review).
 * The workflow sets "1"; unset or empty is a hand run. Anything else ("true", "yes",
 * "0") is refused by name rather than quietly read as "no baseline expected", which
 * would put a run configured with a baseline back on the fixed bar.
 */
export function expectBaselineFrom(raw: string | undefined): { ok: true; expected: boolean } | { ok: false; why: string } {
  if (raw === undefined || raw === "") return { ok: true, expected: false };
  if (raw === "1") return { ok: true, expected: true };
  return { ok: false, why: `EXPECT_BASELINE is ${JSON.stringify(raw)}, and only "1" or unset is understood` };
}
