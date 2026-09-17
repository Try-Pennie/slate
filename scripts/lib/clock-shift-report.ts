// What the shifted test run found, and whether it found anything at all (#2503).
//
// The decision is here, pure and offline, rather than in the workflow step that
// speaks: three outcomes render as one exit code otherwise, and one answering for
// another is how somebody spends a morning on the wrong thing (L11).
//
//   AGREED            every shift ran the whole suite and nothing failed.
//   DATE DEPENDENT    a suite passes today and fails on another day. This is the
//                     finding the run exists for, and it names the suites.
//   UNMEASURED        a shift never ran, ran on the wrong clock, or covered fewer
//                     suites than the checkout holds. It is NOT a pass: a run that
//                     executed nothing and a run that found nothing render the same
//                     in an Actions tab and identically in silence (L98).
//
// The suite COUNT is the anti vacuity floor and it is exact rather than a minimum.
// It comes from the checkout the run was made on, so it cannot drift away from the
// suite it describes the way a number typed beside it would (L41), and a run that
// silently skipped half the files is a finding rather than a clean result.
import { discoverSuiteNames } from "./suite-discovery.ts";

export type ShiftState = "agreed" | "date-dependent" | "unmeasured";

export interface ShiftVerdict {
  /** The shift that was asked for, exactly as the workflow wrote it. */
  spec: string;
  state: ShiftState;
  /** Suites that ran, whatever their result. Zero when nothing could be read. */
  executed: number;
  /** The suites that failed under this shift, in the runner's order. */
  failed: string[];
  /** Why it could not be measured. Empty unless the state is unmeasured. */
  why: string;
}

export interface ClockShiftDecision {
  /** The Slack message, or null when there is nothing worth saying. */
  alert: string | null;
  /** False when the job must go red. */
  ok: boolean;
  /** One line for the runner's own log, whatever the outcome. */
  detail: string;
}

/** The runner's own summary line, which is the only thing this trusts. */
const SUMMARY =
  /^(?:PASS|FAIL): (\d+) passed, (\d+) failed in [\d.]+s \(concurrency \d+(?:, clock ([^)]*))?\)\s*$/m;
const FAILED_LIST = /^Failed: (.+)$/m;

/**
 * Read one shift's captured output.
 *
 * `expectedSuites` is how many files the checkout holds. Anything less means the
 * run did not cover the suite, and a partial run reporting no failures is exactly
 * the false clean this is built to refuse.
 */
export function readShiftLog(
  spec: string,
  log: string,
  expectedSuites: number,
): ShiftVerdict {
  const unmeasured = (why: string): ShiftVerdict => ({
    spec,
    state: "unmeasured",
    executed: 0,
    failed: [],
    why,
  });

  const m = SUMMARY.exec(log);
  if (!m) {
    return unmeasured(
      "the run left no summary line, so it died before the suite finished. Read the step's output.",
    );
  }
  const passed = Number(m[1]);
  const failed = Number(m[2]);
  const clock = (m[3] ?? "").trim();
  const executed = passed + failed;

  // The clock the runner REPORTS, against the shift that was asked for. A hook that
  // silently did nothing would otherwise produce a perfectly clean ordinary run
  // under a shifted run's name, which is the one result that must never read as a pass.
  if (clock === "") {
    return unmeasured(
      `the run was asked for ${spec} and reported no clock at all, so it ran on today's date.`,
    );
  }
  if (clock !== spec) {
    return unmeasured(`the run was asked for ${spec} and reported ${clock}.`);
  }
  if (executed !== expectedSuites) {
    return unmeasured(
      `the run covered ${executed} suites and the checkout holds ${expectedSuites}.`,
    );
  }

  if (failed === 0) return { spec, state: "agreed", executed, failed: [], why: "" };

  const listed = FAILED_LIST.exec(log);
  const names = listed ? (listed[1] as string).split(",").map((s) => s.trim()).filter(Boolean) : [];
  return {
    spec,
    state: "date-dependent",
    executed,
    // A count with no names is still a finding, so the list being empty is reported
    // as the count rather than swallowing the result.
    failed: names.length > 0 ? names : [`${failed} suites (the runner named none)`],
    why: "",
  };
}

/** How many suites the checkout this run was made on holds. */
export function expectedSuiteCount(scriptsDir: string): number {
  return discoverSuiteNames(scriptsDir).length;
}

/**
 * The message and the verdict.
 *
 * `askedFor` is the list of shifts the workflow intended to run, so a step that
 * never produced a log at all is a missing verdict rather than an absence nobody
 * notices: a run that quietly dropped a shift would otherwise report on the two it
 * managed and read as a complete pass.
 */
export function decideClockShiftReport(
  askedFor: string[],
  verdicts: ShiftVerdict[],
  runUrl: string,
): ClockShiftDecision {
  const where = runUrl.trim() ? ` ${runUrl.trim()}` : "";
  const bySpec = new Map(verdicts.map((v) => [v.spec, v]));
  const full: ShiftVerdict[] = askedFor.map(
    (spec) =>
      bySpec.get(spec) ?? {
        spec,
        state: "unmeasured",
        executed: 0,
        failed: [],
        why: "the step produced no output at all, so it never ran.",
      },
  );

  if (full.length === 0) {
    return {
      alert: `The shifted test run asked for no shifts, so nothing was measured.${where}`,
      ok: false,
      detail: "no shifts were asked for",
    };
  }

  const findings = full.filter((v) => v.state === "date-dependent");
  const blind = full.filter((v) => v.state === "unmeasured");

  if (findings.length === 0 && blind.length === 0) {
    const covered = full[0]?.executed ?? 0;
    return {
      alert: null,
      ok: true,
      detail: `${full.length} shifts, ${covered} suites each, all agreed`,
    };
  }

  const lines: string[] = [];
  if (findings.length > 0) {
    lines.push(
      findings.length === 1
        ? "A test suite depends on what day it is."
        : `${findings.length} of the shifted test runs found a suite that depends on what day it is.`,
    );
    for (const v of findings) {
      lines.push(`Run the clock ${v.spec} ahead and these fail: ${v.failed.join(", ")}.`);
    }
    lines.push(
      "Each one passes today and will go red on main by itself on some later day. " +
        "Pin both ends of the fixture, or pass the builder its clock.",
    );
  }
  for (const v of blind) {
    lines.push(`The ${v.spec} run measured nothing: ${v.why}`);
  }
  lines.push(`Run:${where.trim() ? where : " (no run url)"}`);

  return {
    alert: lines.join("\n"),
    ok: false,
    detail:
      `${findings.length} date dependent, ${blind.length} unmeasured, ` +
      `${full.length - findings.length - blind.length} agreed`,
  };
}
