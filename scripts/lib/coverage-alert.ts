/**
 * Whether the nightly coverage run tells a person, and what it says (#3101).
 *
 * The ratchet (#1050) fails the run on a regressed or unmeasured verdict, but the
 * run is scheduled and carried no alert, so a regression was a red run in a tab
 * nobody opens, after the change had already deployed. This reads the verdicts
 * `scripts/coverage.mjs` writes and decides the Slack message. A pass, or a gain
 * asking for the floor to be raised, says nothing: neither is anything to act on
 * tonight (L36).
 *
 * Pure and dependency free: the alerter runs on bare node after the run, whatever
 * it exited with, and `scripts/test-coverage-alert.ts` drives every case. The list
 * of metrics is the ratchet's own, so a metric added there is one a missing verdict
 * is noticed for (L41).
 */
import { RATCHETED_METRICS } from "./coverage-ratchet.mjs";

export interface MetricVerdict {
  verdict: string;
  message: string;
}

/** What coverage.mjs writes to coverage/verdict.json, one entry per ratcheted metric. */
export type VerdictFile = Record<string, MetricVerdict>;

export function decideCoverageAlert(
  fileText: string | null,
  runUrl: string,
): { alert: string | null; detail: string } {
  const link = runUrl.trim() || "(no run link)";
  const unmeasured = (why: string) => ({
    alert: [
      `The nightly coverage run could not measure coverage (${why}), so nothing was compared against the floor and a regression would go unseen.`,
      `Re-run it to get tonight's reading: ${link}`,
    ].join("\n"),
    detail: `unmeasured: ${why}`,
  });

  // No file at all is a run that died before judging: not a pass (L98).
  if (fileText === null) return unmeasured("the run ended before it wrote a verdict");
  let file: VerdictFile;
  try {
    file = JSON.parse(fileText) as VerdictFile;
  } catch {
    return unmeasured("its verdict file could not be read");
  }
  if (typeof file !== "object" || file === null) return unmeasured("its verdict file could not be read");

  const regressed: string[] = [];
  const notMeasured: string[] = [];
  for (const metric of RATCHETED_METRICS) {
    const v = file[metric];
    if (!v || typeof v.verdict !== "string") notMeasured.push(`${metric} was never judged`);
    else if (v.verdict === "unmeasured") notMeasured.push(`${metric}: ${v.message}`);
    else if (v.verdict === "regressed") regressed.push(v.message);
  }

  if (regressed.length > 0) {
    return {
      alert: [
        "Coverage on main fell below its floor overnight. A change merged since the last reading added code without tests or removed tests that covered it.",
        ...regressed,
        ...notMeasured.map((m) => `Also not measured: ${m}`),
        link,
      ].join("\n"),
      detail: `regressed (${regressed.length})`,
    };
  }
  if (notMeasured.length > 0) return unmeasured(notMeasured.join("; "));
  return { alert: null, detail: "every ratcheted metric held its floor" };
}
