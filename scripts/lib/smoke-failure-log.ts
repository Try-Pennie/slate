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
 *  2. **An empty or absent log is its own outcome**, not "no failures". It means the
 *     run died before any check reported, which is a different message from a check
 *     that failed. Collapsing the two is the defect this issue is about.
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
  const flat = message.replace(/\s*\n\s*/g, " ").trim();
  if (!flat) return false;
  try {
    io.append(path, `${flat}\n`);
    return true;
  } catch {
    return false;
  }
}

export type FailureLog =
  | { kind: "failures"; lines: string[] }
  /** The log exists but holds nothing, or does not exist: the run died first. */
  | { kind: "none" }
  /** Configured, present, and unreadable: distinct from empty (L11). */
  | { kind: "unreadable"; reason: string };

/**
 * Read the recorded failures.
 *
 * `none` and `unreadable` are deliberately separate. "The run died before any check
 * reported" and "we could not read what it recorded" lead a reader to different
 * places, and rendering both as no failures is how a message ends up claiming more
 * than it measured.
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
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return lines.length > 0 ? { kind: "failures", lines } : { kind: "none" };
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
