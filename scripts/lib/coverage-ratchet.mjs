/**
 * The coverage ratchet's decision, pure (#1050).
 *
 * The merged coverage report is deliberately report-only (#603): a hard threshold on a
 * mixed two-harness number would be noisy, and that decision stands. What it did not
 * cover is EROSION. Nothing stopped the number sliding except somebody reading a job
 * log, which is the weakest control in the repo.
 *
 * So this is a ratchet, not a threshold. It compares against a floor that is committed
 * and moved by hand, and it only fails on a real DROP:
 *
 *   - within tolerance of the floor, or above it: pass.
 *   - more than `tolerance` below the floor: fail, naming both numbers.
 *   - meaningfully above the floor: pass, and print the value to raise it to, so the
 *     floor moves in a commit somebody reviews rather than by a bot pushing to main
 *     (which the main-push guard would page about, correctly).
 *
 * The tolerance is not slack for its own sake. The number moves a little on its own:
 * the union of two harnesses shifts when a file is added, and the vitest half maps
 * through a transform. A ratchet that fired on noise would be turned off within a week,
 * which is the failure mode to design against.
 */

/**
 * The metrics held to a floor, each with its own key in scripts/coverage-floor.json.
 * Statements since #1050; branches since #3101, because a statements floor alone lets
 * a change add untested branches inside lines that some other test already executes.
 */
export const RATCHETED_METRICS = /** @type {const} */ (["statements", "branches"]);

/** How far below the floor is treated as noise rather than erosion. */
export const DEFAULT_TOLERANCE = 1;
/** How far above the floor before it is worth raising it. */
export const RAISE_AT = 1;

/**
 * @param {{ floor: number|undefined, measured: number|null, tolerance?: number, metric?: string }} input
 * @returns {{ verdict: "pass"|"regressed"|"unmeasured"|"raise", message: string, suggestFloor?: number }}
 */
export function judgeCoverage({ floor, measured, tolerance = DEFAULT_TOLERANCE, metric = "statements" }) {
  // A metric with no recorded floor compares against nothing. That is not a pass
  // either, for the same reason as an unreadable number below.
  if (typeof floor !== "number" || !Number.isFinite(floor)) {
    return {
      verdict: "unmeasured",
      message:
        `no ${metric} floor is recorded in scripts/coverage-floor.json, so nothing was compared` +
        (typeof measured === "number" && Number.isFinite(measured)
          ? `. ${metric} coverage measured ${measured.toFixed(2)}%: record that as its floor.`
          : "."),
    };
  }
  // An unmeasurable number must never read as a pass (L98): a coverage run that
  // produced nothing and a run that produced a healthy number look identical to a
  // caller that only checks for a failure.
  if (measured === null || !Number.isFinite(measured)) {
    return {
      verdict: "unmeasured",
      message:
        `could not read a ${metric} coverage percentage from the merged report, so nothing was compared. This is a failure, not a pass: a run that measured nothing and a run that measured a healthy number are indistinguishable to anything downstream.`,
    };
  }
  const delta = measured - floor;
  if (delta < -tolerance) {
    return {
      verdict: "regressed",
      message:
        `${metric} coverage is ${measured.toFixed(2)}%, more than ${tolerance} point below the floor of ` +
        `${floor.toFixed(2)}%. Add a test for what this change introduced, or move the floor in ` +
        `this commit and say why it is going down.`,
    };
  }
  if (delta >= RAISE_AT) {
    return {
      verdict: "raise",
      message:
        `${metric} coverage is ${measured.toFixed(2)}%, ${delta.toFixed(2)} points above the floor of ` +
        `${floor.toFixed(2)}%. Raise "${metric}" to ${measured.toFixed(2)} in scripts/coverage-floor.json ` +
        `so the gain is held.`,
      suggestFloor: Number(measured.toFixed(2)),
    };
  }
  return {
    verdict: "pass",
    message: `${metric} coverage is ${measured.toFixed(2)}% against a floor of ${floor.toFixed(2)}%.`,
  };
}

/**
 * Pull one metric's percentage (`statements`, `branches`) out of an istanbul summary.
 *
 * Returns null rather than 0 when it is not there, because 0 is a real coverage number
 * and "no number" is not: mapping one onto the other is how a broken report becomes a
 * regression alert about nothing, or worse, a pass.
 *
 * @param {unknown} summary
 * @param {string} [metric]
 * @returns {number|null}
 */
export function metricPct(summary, metric = "statements") {
  const pct = /** @type {Record<string, { pct?: unknown } | undefined> | null | undefined} */ (summary)?.[metric]?.pct;
  return typeof pct === "number" && Number.isFinite(pct) ? pct : null;
}

/** How verdicts rank when several metrics are judged: the worst names the run. */
const RANK = { unmeasured: 3, regressed: 2, raise: 1, pass: 0 };

/**
 * The run's verdict from every metric's: unmeasured over regressed over raise over pass.
 * No judgements at all is unmeasured, never a pass (L98).
 *
 * @param {Array<{ verdict: "pass"|"regressed"|"unmeasured"|"raise" }>} judgements
 * @returns {"pass"|"regressed"|"unmeasured"|"raise"}
 */
export function worstVerdict(judgements) {
  if (judgements.length === 0) return "unmeasured";
  /** @type {"pass"|"regressed"|"unmeasured"|"raise"} */
  let worst = "pass";
  for (const j of judgements) if (RANK[j.verdict] > RANK[worst]) worst = j.verdict;
  return worst;
}
