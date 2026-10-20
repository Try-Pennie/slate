// What the shifted test run found, and whether it found anything at all (#2503).
//
// The decision is here, pure and offline, rather than in the workflow step that
// speaks: three outcomes render as one exit code otherwise, and one answering for
// another is how somebody spends a morning on the wrong thing (L11).
//
//   AGREED            every shift ran the whole suite and nothing failed.
//   DATE DEPENDENT    a suite passes today and fails on another day. This is the
//                     finding the run exists for, and it names the suites.
//   UNMEASURED        a shift never ran, hit its time limit, was cancelled, ran on
//                     the wrong clock, or covered fewer suites than the checkout
//                     holds. It is NOT a pass: a run that executed nothing and a
//                     run that found nothing render the same in an Actions tab and
//                     identically in silence (L98).
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

/**
 * The runner's own summary line, which is the only thing this trusts. Its shape is
 * formatted by `formatRunSummary` (scripts/lib/run-summary.ts). The bracket holds
 * `, ` separated fields, and the clock is read as ONE of them rather than captured
 * up to the closing bracket: the tree write tripwire (#2733) added a field after
 * the clock, the old capture read `+1d, tripwire on` as the clock, and every shift
 * was reported unmeasured every night (#2813). A field added later must not be able
 * to join the clock again.
 */
const SUMMARY = /^(?:PASS|FAIL): (\d+) passed, (\d+) failed in [\d.]+s \(([^)]*)\)\s*$/m;
const CONCURRENCY_FIELD = /^concurrency \d+$/;
const CLOCK_FIELD = "clock ";

/**
 * The fields inside the summary's bracket, or null when the bracket is not the
 * runner's (its first field is always the concurrency). Returning null rather than
 * an empty list keeps a malformed line on the no summary branch instead of letting
 * it read as a run that reported no clock.
 */
function summaryFields(bracket: string): string[] | null {
  const fields = bracket.split(",").map((f) => f.trim());
  if (!CONCURRENCY_FIELD.test(fields[0] ?? "")) return null;
  return fields;
}
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
  const fields = m ? summaryFields(m[3] as string) : null;
  if (!m || !fields) {
    return unmeasured(
      `the run left no summary line, so it died before the suite finished. Read the ${spec} job's log.`,
    );
  }
  // Both captures are `\d+`, so neither can be NaN, and the comparisons below are
  // equalities rather than thresholds: a NaN that somehow reached them would fail
  // `executed !== expectedSuites` and land on `unmeasured`, which is the fail safe
  // side (L50). A parsed number reaching a threshold check is how the permissive
  // branch gets taken with no error raised anywhere.
  const passed = Number(m[1]);
  const failed = Number(m[2]);
  // No clock field reads as "", which the next check refuses as a run on today's
  // date. Two clock fields cannot come from the formatter; taking the first keeps
  // the comparison below an equality, so a stray second one cannot make it pass.
  const clockField = fields.find((f) => f.startsWith(CLOCK_FIELD));
  const clock = clockField ? clockField.slice(CLOCK_FIELD.length).trim() : "";
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

/**
 * How one shift's pass ended, from the marker its job writes beside its log (#3960).
 *
 * Each shift runs in its own job. The step running the suite writes `exit=` and
 * `seconds=` once the suite has stopped, for whatever reason, and an `if: always()`
 * step then adds `step=` (GitHub's outcome for that step) and `limit_minutes=` (the
 * pass's own time limit). A pass the job was cancelled under never writes the first
 * two, which is itself the evidence: the step outcome says `cancelled`.
 */
export interface ShiftOutcome {
  /** GitHub's outcome for the suite step: success, failure, cancelled, skipped, or "" when not recorded. */
  step: string;
  /** The suite's exit code, or null when the step never got past the suite. */
  exit: number | null;
  /** How long the step ran, in seconds, or null. */
  seconds: number | null;
  /** The pass's own time limit in minutes, or null. */
  limitMinutes: number | null;
}

/** A whole number or null: an empty or unreadable value never reaches a comparison as NaN (L50). */
function wholeNumber(raw: string | undefined): number | null {
  return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : null;
}

/** Read a marker. Unknown keys are ignored; a key written twice keeps its first value. */
export function readShiftOutcome(text: string): ShiftOutcome {
  const fields = new Map<string, string>();
  for (const line of text.split("\n")) {
    const at = line.indexOf("=");
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    if (!fields.has(key)) fields.set(key, line.slice(at + 1).trim());
  }
  return {
    step: fields.get("step") ?? "",
    exit: wholeNumber(fields.get("exit")),
    seconds: wholeNumber(fields.get("seconds")),
    limitMinutes: wholeNumber(fields.get("limit_minutes")),
  };
}

/** `timeout` exits 124 when it stops the suite, or 137 when the suite outlived its kill grace too. */
const TIMEOUT_EXIT = 124;
const KILLED_EXIT = 137;

/**
 * Whether the pass's own time limit stopped it. A 137 counts only once the pass had
 * run past its limit: inside it, something other than the clock killed the suite,
 * and blaming the limit would send somebody to raise a number nothing reached.
 */
function stoppedByLimit(o: ShiftOutcome): boolean {
  if (o.exit === TIMEOUT_EXIT) return true;
  return (
    o.exit === KILLED_EXIT &&
    o.seconds !== null &&
    o.limitMinutes !== null &&
    o.seconds >= o.limitMinutes * 60
  );
}

/** Said when a shift's job left nothing at all for the report to read. */
const LEFT_NOTHING = "its job left nothing to read, so it never ran or its log never reached the report.";

/**
 * One shift's verdict from what its job left behind: its log, its marker, either,
 * or neither (#3960). A log carrying the runner's summary is the verdict whatever the
 * marker says, because the suite finished. Without one, the marker says WHY there is
 * no verdict, which is the difference between a pass that hit its time limit (raise
 * the limit, or split the suite) and one that crashed (read what it printed): the
 * 2026-10-20 alert answered the first with the second's words.
 */
export function judgeShift(
  spec: string,
  log: string | null,
  outcome: ShiftOutcome | null,
  expectedSuites: number,
): ShiftVerdict {
  if (log !== null && SUMMARY.test(log)) return readShiftLog(spec, log, expectedSuites);
  const unmeasured = (why: string): ShiftVerdict => ({
    spec,
    state: "unmeasured",
    executed: 0,
    failed: [],
    why,
  });
  const where = `What it printed by then is in the ${spec} job's log.`;
  if (outcome && stoppedByLimit(outcome)) {
    const limit = outcome.limitMinutes !== null ? `its ${outcome.limitMinutes} minute` : "its";
    return unmeasured(`it hit ${limit} time limit and was stopped before the suite finished. ${where}`);
  }
  if (outcome?.step === "cancelled") {
    return unmeasured(
      `it was cancelled before the suite finished, by hand or by the job's own time limit. ${where}`,
    );
  }
  if (outcome?.step === "skipped") {
    return unmeasured(`its job stopped before the suite started. The ${spec} job's earlier steps say why.`);
  }
  if (log !== null) return readShiftLog(spec, log, expectedSuites);
  return unmeasured(LEFT_NOTHING);
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
        why: LEFT_NOTHING,
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
