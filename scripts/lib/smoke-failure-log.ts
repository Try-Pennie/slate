import { appendFileSync, readFileSync } from "node:fs";

/**
 * The canary's failed checks, carried from the smoke run to the Slack alerter
 * (#1492).
 *
 * Every canary failure posted the same sentence: "either booking is broken, or a
 * smoke key or seeded test fixture is misconfigured". That covers every possible
 * cause, so it tells the reader nothing and every page needs a code read plus a
 * production query to interpret. Three pages in ten days (#1489) were all the same
 * benign fixture collision and none could be told apart from a real booking outage
 * by reading Slack. An alert that cannot distinguish its own causes is how a channel
 * stops being trusted.
 *
 * The smoke script already prints one line per failed check. The alerter runs as a
 * SEPARATE process in a later workflow step, so the lines have to cross a file.
 *
 * Two design points, both load-bearing:
 *
 *  1. **Append as each failure happens, never at exit.** The run can die before it
 *     finishes: on 2026-08-14 it threw on an unparseable URL before a single booking
 *     check ran. A log written at exit would have been empty for exactly the failure
 *     that most needed explaining.
 *  2. **An empty or absent log is its own outcome**, not "no failures". It means
 *     nothing was recorded at all, which is a different message from a check that
 *     failed. Collapsing the two is the defect this issue is about. Since #4062 the
 *     log also holds passes and crashes, so a run that crashed after passing checks
 *     reads as `crashed`, never as an empty log.
 */

export interface FailureLogIo {
  append(path: string, line: string): void;
  read(path: string): string | null;
}

/** Where the run records its failed checks, when the workflow asks it to. */
export function failureLogPath(env: Record<string, string | undefined>): string | null {
  const p = env.SMOKE_FAILURE_FILE?.trim();
  return p ? p : null;
}

/**
 * Record one failed check. A no-op when no path is configured, so a hand-run smoke
 * behaves exactly as before.
 *
 * Never throws: a failure to write the log must not change the outcome of the run it
 * is describing. It reports whether it wrote, so the caller can say so rather than
 * assuming.
 */
export function recordFailure(
  io: FailureLogIo,
  path: string | null,
  message: string,
): boolean {
  if (!path) return false;
  // One line per failure, so the reader is a plain line split. A message containing
  // a newline would otherwise read as two failures.
  const flat = flatten(message);
  if (!flat) return false;
  // A failure can never be read back as one of the marks below.
  return appendLine(io, path, flat.startsWith("[") ? `FAIL: ${flat}` : flat);
}

/**
 * #4062: the two marks beside the failed checks. On 2026-10-21 (run 39694932888) the
 * reschedule smoke passed 4 checks and then crashed on a connect timeout, and the
 * alert said the run "stopped before the checks began", because the file held only
 * FAILURES and the crash handler wrote nothing. An empty file could not tell "never
 * started" from "crashed after passing checks". Now a passing check appends
 * `[pass]` and a crash appends `[crash] <which smoke>: <short reason>`, so the alert
 * can say only what was recorded.
 */
const PASS_MARK = "[pass]";

/**
 * How each smoke names itself in its pass marks, its crash line and the alert: one
 * list, so a crash is matched to the passes of the SAME smoke. Several smokes write
 * one file in the canary, and a crash may claim only its own passes (L11).
 */
export const SMOKE_NAMES = {
  booking: "The booking smoke",
  reschedule: "The reschedule smoke",
  stickiness: "The stickiness repro",
  createResume: "The create resume smoke",
  embedRender: "The embed render check",
  latency: "The latency check",
} as const;
const CRASH_MARK = "[crash] ";

/**
 * Record one passing check, tagged with the smoke that ran it (`where`, a name from
 * SMOKE_NAMES), so a later crash of that smoke counts only its own passes. A no-op
 * without a path; never throws.
 */
export function recordPass(io: FailureLogIo, path: string | null, where: string): boolean {
  if (!path) return false;
  const w = smokeName(where);
  return appendLine(io, path, w ? `${PASS_MARK} ${w}` : PASS_MARK);
}

/** One spelling of a smoke's name for its pass marks and its crash line alike. */
function smokeName(where: string): string {
  return flatten(where).replace(/:/g, "");
}

/**
 * Record that a smoke crashed. `where` names the smoke in words ("The reschedule
 * smoke"); `reason` is already short (crashReason in scripts/lib/smoke-crash.ts),
 * never a raw error, since it lands in Slack. A no-op without a path; never throws.
 */
export function recordCrash(io: FailureLogIo, path: string | null, where: string, reason: string): boolean {
  if (!path) return false;
  const w = smokeName(where);
  const r = flatten(reason);
  if (!w || !r) return false;
  return appendLine(io, path, `${CRASH_MARK}${w}: ${r}`);
}

function flatten(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").trim();
}

function appendLine(io: FailureLogIo, path: string, line: string): boolean {
  try {
    io.append(path, `${line}\n`);
    return true;
  } catch {
    return false;
  }
}

/** A crash as recorded, with how many checks had passed before it. */
export interface CrashRecord {
  where: string;
  reason: string;
  passedBefore: number;
}

export type FailureLog =
  /** At least one check failed. A crash beside them, if any, is carried too. */
  | { kind: "failures"; lines: string[]; passed?: number; crashes?: CrashRecord[] }
  /** No check failed, and a smoke crashed (#4062). */
  | { kind: "crashed"; passed: number; crashes: CrashRecord[] }
  /** Checks passed, none failed, nothing crashed, and yet the run failed (#4062). */
  | { kind: "stopped"; passed: number }
  /** The log exists but holds nothing, or does not exist: nothing was recorded. */
  | { kind: "none" }
  /** Configured, present, and unreadable: distinct from empty (L11). */
  | { kind: "unreadable"; reason: string };

/**
 * Read what the run recorded: failed checks, passes and crashes.
 *
 * Each state says only what the log holds (L11): `failures` (a check failed, with
 * any crash beside it), `crashed` (no check failed, a smoke crashed), `stopped`
 * (checks passed and nothing else was recorded), `none` (nothing was recorded) and
 * `unreadable` (we could not read what it recorded). Rendering any two of them alike
 * is how a message ends up claiming more than it measured.
 */
export function readFailures(io: FailureLogIo, path: string | null): FailureLog {
  if (!path) return { kind: "none" };
  let raw: string | null;
  try {
    raw = io.read(path);
  } catch (err) {
    return { kind: "unreadable", reason: err instanceof Error ? err.message : String(err) };
  }
  if (raw === null) return { kind: "none" };
  const lines: string[] = [];
  const crashes: CrashRecord[] = [];
  let passed = 0;
  // Passes per smoke: a crash is credited only with the passes of the smoke that
  // crashed, never with another smoke's that wrote the same file before it (L11).
  const passedBy = new Map<string, number>();
  for (const raw_line of raw.split("\n")) {
    const l = raw_line.trim();
    if (!l) continue;
    if (l === PASS_MARK || l.startsWith(`${PASS_MARK} `)) {
      passed += 1;
      const who = l.slice(PASS_MARK.length).trim();
      if (who) passedBy.set(who, (passedBy.get(who) ?? 0) + 1);
      continue;
    }
    if (l.startsWith(CRASH_MARK)) {
      const body = l.slice(CRASH_MARK.length);
      const at = body.indexOf(": ");
      const where = at > 0 ? body.slice(0, at) : "A smoke";
      crashes.push({
        where,
        reason: at > 0 ? body.slice(at + 2) : body,
        passedBefore: passedBy.get(where) ?? 0,
      });
      continue;
    }
    lines.push(l);
  }
  if (lines.length > 0) return { kind: "failures", lines, passed, crashes };
  if (crashes.length > 0) return { kind: "crashed", passed, crashes };
  if (passed > 0) return { kind: "stopped", passed };
  return { kind: "none" };
}

/**
 * Real filesystem writes for the smoke scripts. Appends, so a failure recorded
 * earlier in the run survives a later crash, and creates the file on first write.
 */
export const nodeSmokeFailureIo: FailureLogIo = {
  append: (path, line) => appendFileSync(path, line, "utf8"),
  read: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return null;
      throw err;
    }
  },
};
