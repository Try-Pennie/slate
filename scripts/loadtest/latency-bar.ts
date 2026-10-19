/**
 * Judging the load run's latency against the day it ran on (#3258).
 *
 * The bar was a fixed 5s p95. On 2026-10-04 the 09-15 code, which passed that bar
 * on 09-15 at 3.5s, measured 7.0s on the same rig against a fresh throwaway branch,
 * and the three arm experiment that day measured 6.6s with the suspect removed. A
 * fixed bar was judging the throwaway environment more than the code: about 1.5s of
 * the median moved with the day on identical code.
 *
 * So a run now measures its own day. A BASELINE leg books at rest, one every ten
 * seconds, on the same deployment and branch just before the steady pass, when
 * nothing else is running: a warm up of two the judge drops, then twenty measured
 * (#3517, the constants below). Their median is what one booking costs on that
 * environment at rest. The steady pass is then held to a MULTIPLE of it: the bar
 * asks how much the code degrades under the steady load, which is the code's
 * property, and the environment cancels because both halves ran on it within
 * minutes of each other.
 *
 * What the ratio does NOT judge, stated so nobody reads more into a pass: a change
 * that makes every booking slower at rest raises the baseline and the bar with it,
 * and so does a baseline that simply read slow. So the steady p95 is ALSO held to a
 * fixed limit (#3517, `STEADY_P95_LIMIT_MS`) that holds whatever the baseline reads.
 * Both are judged on every run with a baseline, and a failure names which one failed.
 *
 * Why the baseline swung, measured for #3517 rather than assumed. Across the 13 runs
 * since 2026-10-15 (four at 90 advisors, nine at 200), the FIRST at rest booking was
 * 1.58 times the median of the rest on the median run and over 1.5 times on 9 of 13;
 * no later position was systematically slow. Read on the server for runs 39086610096,
 * 39090439214 and 39093966606 (one commit, edc42c10), the first confirm's call to the
 * per address exact ceiling took 251 to 350ms: the `BURST_LIMITER` object for the
 * baseline runner's address and this run is new on that call (#3416, #3456). Cold
 * isolates were NOT the swing at this pace: 1 of the 36 baseline confirms was its
 * isolate's first request. Beyond the first booking, the run with the slow baseline
 * (39090439214, median 842ms) paid 215ms on the median call to that same object against
 * 42 and 55ms on the other two (medians 580 and 668ms), while the nine steady drivers'
 * p50 stayed at 595 to 625ms on all three: the baseline is ONE runner's address, so
 * where its object answers from moves the whole sample, and twelve bookings add about
 * plus or minus 8 percent of sampling noise on top (a bootstrap of the pooled runs).
 * The warm up below removes the first booking's cost and more bookings halve the
 * noise; the per runner part remains, which is what the fixed limit backstops.
 *
 * The older swing in the issue (2.7s to 9.6s, runs 37520312761 to 37699327346) was a
 * different environment: every booking of 37601024392's baseline took 6.8 to 12.3s,
 * so the whole branch was slow during it, not its first minutes.
 */
import type { DriverResult } from "./book-plan.ts";

/**
 * How many leading bookings the baseline sends and then drops (#3517). The first
 * booking of a run is its slowest on most runs (above); one more is dropped as margin,
 * so a refused or unanswered first booking still leaves the address's object warm
 * before anything is measured. Dropped by POSITION, never by speed, so the rule can
 * never flatter the baseline. 10s of run time at the pace below.
 */
export const BASELINE_WARMUP = 2;
/**
 * How many bookings the median is taken over, after the warm up. Twenty halves the
 * spread twelve gave: a bootstrap over the 13 runs' pooled at rest bookings puts the
 * 90 percent band of a median at plus or minus 8 percent for 12 and 5.6 for 20.
 */
export const BASELINE_BOOKINGS = 20;
/** What the baseline driver plans: the warm ups, then the measured bookings. */
export const BASELINE_PLANNED = BASELINE_WARMUP + BASELINE_BOOKINGS;
/**
 * One every ten seconds. At rest bookings took 0.4 to 1.3s on every run since
 * 2026-10-15 (12.3s at worst on the slow branches before), and the driver sends one at
 * a time, so they never overlap. The leg's schedule is 21 gaps of 10s, 210s, against
 * 165s for the twelve at four a minute: 45s more per run.
 */
export const BASELINE_PER_MINUTE = 6;
/**
 * Fewer measured successes than this and there is no median worth a bar: the speed
 * verdict is void. Two thirds of the measured bookings, the share the twelve held (8).
 */
export const BASELINE_MIN_OK = 14;

/**
 * The steady p95 may be at most this multiple of the baseline median.
 *
 * RESOLVED (#3517, 2026-10-18): no longer provisional. It was set from the 2026-10-04
 * three arm run with single at rest bookings standing in for a baseline. Runs with a
 * real baseline then confirmed it: on the 200 advisor runs on edc42c10 (39086610096,
 * 39090439214, 39093966606) the steady p95 sat at 2.5, 1.7 and 2.4 times the baseline,
 * and the one known regression (39055855051, cold isolates before #3884) read 2.7.
 * What moved those ratios was the baseline, not the steady pass (above), so the fix was
 * a steadier baseline and the fixed limit below, and the multiple stays 2.5.
 */
export const LOAD_OVER_REST_RATIO_BAR = 2.5;

/**
 * The steady p95 may never exceed this, whatever the baseline reads (#3517, Dan,
 * 2026-10-18). A run whose baseline is itself slow is otherwise judged against a
 * looser bar and can pass at a slow absolute speed.
 *
 * Calibrated on the 200 advisor runs of #3829 on Large compute with the Google stand in
 * answering at once, every one after #3884's smaller script, whose speed was judged:
 * runs 3 to 9, 39065162547 (1410ms), 39070434640 (1488), 39074912498 (1310),
 * 39080050822 (1578), 39086610096 (1446), 39090439214 (1423) and 39093966606 (1609).
 * The passing ones are 4, 7, 8 and 9 (1423 to 1609); 3, 5 and 6 failed other bars with
 * speed inside both checks. Mean 1466ms, standard deviation about 103ms.
 *
 * 1800ms is 191ms (12 percent) over the slowest of them and about 3.2 deviations over
 * the mean, so it sits clear of the dense middle (1310 to 1609, L172) rather than
 * inside it, where it would fail healthy runs at random. Below it is the one measured
 * regression on this rig: run 2 (39055855051, 1989ms, nine percent of confirms on a
 * fresh isolate before #3884) fails it by 189ms. The 90 advisor runs (932 to 1334ms)
 * are well inside it.
 *
 * It does NOT apply to a run dispatched with a Google delay (#3490): those carry Google
 * time in every confirm, which none of the calibration runs did, so the limit is
 * reported as not applied and the ratio, whose baseline carries the delay too, judges
 * alone. Recalibrate it, beside these figures, when the rig changes (compute size,
 * roster, a delay that becomes the default).
 */
export const STEADY_P95_LIMIT_MS = 1800;

/** Which of the two checks a run failed, ratio first, in the order the report states them. */
export type SpeedCheck = "ratio" | "fixed limit";

export type LatencyJudgement =
  | {
      kind: "relative";
      steadyP95: number;
      /** The median over the measured bookings, after the warm up was dropped. */
      baselineP50: number;
      /** How many measured bookings succeeded, the warm ups never among them. */
      baselineOk: number;
      /** The wall time of each warm up the median dropped, in send order, so the report shows them. */
      warmupMs: number[];
      ratioBarMs: number;
      ratio: number;
      ratioPass: boolean;
      /** The fixed limit, or null when it did not apply (a run dispatched with a Google delay). */
      fixedLimitMs: number | null;
      fixedPass: boolean;
      pass: boolean;
      failedChecks: SpeedCheck[];
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
    const at = a as { n?: unknown; status?: unknown; wallMs?: unknown } | null;
    if (typeof at?.status !== "number") return `attempt ${i} has no numeric status`;
    if (typeof at?.wallMs !== "number" || !Number.isFinite(at.wallMs)) return `attempt ${i} has no finite wallMs`;
    // #3517: the warm up is dropped by position, so a position that cannot be read
    // would leave nobody able to say which bookings were the warm up.
    if (typeof at?.n !== "number" || !Number.isInteger(at.n)) return `attempt ${i} has no whole number position n`;
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
 * - A usable baseline judges two checks (#3517): the ratio against its median, taken
 *   after the first `BASELINE_WARMUP` bookings are dropped, and the fixed limit,
 *   which holds whatever the baseline reads unless the run carried a Google delay.
 */
export function judgeLatency(input: {
  steadyP95: number;
  absoluteBarMs: number;
  baseline: BaselineReading | undefined;
  baselineExpected: boolean;
  runId: string;
  /**
   * #3517: whether the run was dispatched with a Google stand in delay (#3490). The
   * fixed limit was calibrated with none, so with one it is reported as not applied.
   * Required, so every caller says which rig it judged (L167).
   */
  googleDelayed: boolean;
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
  // #3517: the warm up is dropped by POSITION in the plan, never by speed, and its
  // successes never count toward the floor.
  const warmup = baseline.attempts.filter((a) => a.n < BASELINE_WARMUP);
  const measured = baseline.attempts.filter((a) => a.n >= BASELINE_WARMUP);
  const ok = measured.filter((a) => a.status === 200).map((a) => a.wallMs);
  if (ok.length < BASELINE_MIN_OK) {
    return {
      kind: "unmeasured",
      why:
        `the same day baseline confirmed ${ok.length} of the ${measured.length} bookings it measured after its ` +
        `${BASELINE_WARMUP} warm up, and a median needs at least ${BASELINE_MIN_OK}`,
    };
  }
  const baselineP50 = median(ok);
  const ratioBarMs = Math.round(baselineP50 * LOAD_OVER_REST_RATIO_BAR);
  const ratioPass = steadyP95 <= ratioBarMs;
  const fixedLimitMs = input.googleDelayed ? null : STEADY_P95_LIMIT_MS;
  const fixedPass = fixedLimitMs === null || steadyP95 <= fixedLimitMs;
  const failedChecks: SpeedCheck[] = [...(ratioPass ? [] : ["ratio" as const]), ...(fixedPass ? [] : ["fixed limit" as const])];
  return {
    kind: "relative",
    steadyP95,
    baselineP50,
    baselineOk: ok.length,
    warmupMs: warmup.map((a) => a.wallMs),
    ratioBarMs,
    ratio: baselineP50 > 0 ? steadyP95 / baselineP50 : Infinity,
    ratioPass,
    fixedLimitMs,
    fixedPass,
    pass: failedChecks.length === 0,
    failedChecks,
  };
}

type RelativeJudgement = Extract<LatencyJudgement, { kind: "relative" }>;

/** The ratio check as a reported figure, worded the same in the finding and the report. */
function ratioText(j: RelativeJudgement): string {
  return (
    `${j.ratio.toFixed(1)} times the same day baseline's median of ${j.baselineP50}ms (${j.baselineOk} ` +
    `bookings at rest, first ${BASELINE_WARMUP} dropped as warm up), against the ${LOAD_OVER_REST_RATIO_BAR} ` +
    `times bar of ${j.ratioBarMs}ms`
  );
}

/** The fixed limit as a reported figure, or why it did not apply. */
function fixedText(j: RelativeJudgement): string {
  return j.fixedLimitMs === null
    ? `the ${STEADY_P95_LIMIT_MS}ms fixed limit was not applied, because the run carried a Google delay and the ` +
        "limit was calibrated with none"
    : `the ${j.fixedLimitMs}ms fixed limit`;
}

/**
 * The latency finding's detail on a failed speed verdict (#3517): which check failed,
 * ratio, fixed limit or both, with both numbers stated either way, so a reader never
 * has to work out from one number which rule the run broke (L11).
 */
export function latencyFailureDetail(j: RelativeJudgement, ok: { p50: number; max: number }): string {
  const tail = `(p50 ${ok.p50}ms, max ${ok.max}ms)`;
  const ratio = ratioText(j);
  const fixed = fixedText(j);
  if (!j.ratioPass && !j.fixedPass) {
    return `p95 ${j.steadyP95}ms failed both checks: it is ${ratio}, and over ${fixed} ${tail}`;
  }
  if (!j.ratioPass) {
    // With no fixed limit applied there is nothing it was inside: say why instead.
    const other = j.fixedLimitMs === null ? fixed : `it is inside ${fixed}`;
    return `p95 ${j.steadyP95}ms failed the ratio check: it is ${ratio}; ${other} ${tail}`;
  }
  return `p95 ${j.steadyP95}ms failed the fixed limit: it is over ${fixed}, which holds whatever the baseline reads; it is inside the ratio check at ${ratio} ${tail}`;
}

/**
 * The absolute bar as a reported figure. Since #3517 only a hand run with no baseline
 * reports it, where it IS the pass rule, so it no longer says it is not.
 */
function absoluteBarText(j: { steadyP95: number; absoluteBarMs: number }): string {
  return j.steadyP95 > j.absoluteBarMs
    ? `p95 ${j.steadyP95}ms is over the ${j.absoluteBarMs}ms absolute bar`
    : `p95 ${j.steadyP95}ms is inside the ${j.absoluteBarMs}ms absolute bar`;
}

/**
 * The report's one line on latency: which rule judged it and against what. With a
 * baseline (#3517) that is the median, the warm ups it dropped, and both checks with
 * each one's verdict; a hand run states the fixed 5s bar and why it judged.
 */
export function latencyReportLine(j: LatencyJudgement, platformUnmeasured: string | null = null): string {
  if (j.kind === "unmeasured") {
    // The same rule the verdict line follows (L11): the other bars are claimed as
    // judged only when the platform half was read too.
    return platformUnmeasured === null
      ? `- latency: UNMEASURED, so the speed verdict is void and every other bar was judged; ${j.why}`
      : `- latency: UNMEASURED, so the speed verdict is void, and platform limits were UNMEASURED ` +
          `too (${platformUnmeasured}), so only the remaining bars were judged; ${j.why}`;
  }
  if (j.kind === "absolute") {
    return `- latency: judged against the fixed ${j.absoluteBarMs}ms bar because ${j.why}; ${absoluteBarText(j)}`;
  }
  // #3517: both checks, each with its own verdict, and the warm ups the median dropped,
  // so a reader can see what the baseline was taken over and which check decided.
  const warm = j.warmupMs.length === 0 ? "none sent" : j.warmupMs.map((ms) => `${ms}ms`).join(", ");
  const fixed =
    j.fixedLimitMs === null
      ? `fixed limit not applied: the run carried a Google delay and the ${STEADY_P95_LIMIT_MS}ms fixed limit was calibrated with none`
      : `${j.fixedPass ? "inside" : "OVER"} the ${j.fixedLimitMs}ms fixed limit`;
  return (
    `- latency: same day baseline median ${j.baselineP50}ms over ${j.baselineOk} bookings at rest (first ` +
    `${BASELINE_WARMUP} dropped as warm up: ${warm}); the steady p95 of ${j.steadyP95}ms is ` +
    `${j.ratio.toFixed(1)} times it, ${j.ratioPass ? "inside" : "OVER"} the ratio bar of ` +
    `${LOAD_OVER_REST_RATIO_BAR} times (${j.ratioBarMs}ms), and ${fixed}`
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
  /**
   * #3429: the burst clauses that could not conclude. Required, never optional (#3459
   * review, L167): a caller that left it out would get a verdict line silent about
   * why a run could not conclude, and nothing would say so.
   */
  burstsUnconcluded: readonly { bar: string; detail: string }[];
  /** #3429: each burst's notes, for a known defect the deployment declares; null when nothing was measured. */
  measurements: { bursts: readonly { notes: readonly string[] }[] } | null;
}): string {
  // #3429: a known defect the deployment declares is never a silent pass, on the line
  // a reader looks at first: a pass is held to the rule the build says it runs.
  const noted = (r.measurements?.bursts ?? []).filter((b) => b.notes.length > 0).length;
  const declared =
    noted > 0
      ? `, held to the rule the deployment declares: ${noted} burst${noted === 1 ? "" : "s"} showed #3338's known ` +
        "defect on a build that says a crowd stops at its rung, which fails once it says a crowd walks the ladder"
      : "";
  const head = `Verdict: **${r.verdict.toUpperCase()}**${declared}`;
  const open = r.burstsUnconcluded;
  const causes = [
    ...(r.speedUnmeasured !== null ? [`speed was UNMEASURED because ${r.speedUnmeasured}`] : []),
    ...(r.platformUnmeasured !== null ? [`platform limits were UNMEASURED because ${r.platformUnmeasured}`] : []),
    ...(open.length > 0
      ? [
          `${open.length} burst clause${open.length === 1 ? "" : "s"} could not conclude ` +
            `(${open.map((o) => o.bar).join(", ")}; each is listed under "What the bursts could not conclude")`,
        ]
      : []),
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
