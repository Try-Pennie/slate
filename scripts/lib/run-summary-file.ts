/**
 * The verdict a scheduled proof hands from its command step to its reporter step.
 *
 * The burst counter (#2392), the kill switch (#2493) and the shared confirm line (#3340)
 * each run a command that decides, then a reporter in a later step that says whether
 * anything was MEASURED. The file between them is how a verdict is told apart from a
 * run that died before reaching one: node exits 1 on an uncaught throw, and 1 is also a
 * real ending of each command, so an exit code alone makes those one message (L11). An
 * absent file is evidence rather than an inference (L98).
 *
 * The WRITE and the READ live here together because they are two halves of one contract
 * across two processes, and they were written out twice before this file existed.
 *
 * Bare node safe: node builtins only, because the reporters run with no install (#1598).
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

export interface RunSummary {
  /** The command's exit code: the whole judgement. */
  exit: number;
  /** The command's own sentence about what it found. */
  detail: string;
}

/**
 * Write the verdict where the reporter can read it. Returns whether it landed and NEVER
 * throws: the command has already measured what it measured, and a failed write must not
 * turn a reported verdict into a run that looks as though it never happened. The failure
 * direction is the safe one, since with no file the reporter says the run did not
 * complete and the heartbeat stays unstamped, louder than the truth (L95). An empty path
 * writes nothing and says so: a hand run sets none and is reading the terminal.
 */
export function writeRunSummary(path: string, summary: RunSummary): { written: boolean; why: string } {
  if (!path.trim()) return { written: false, why: "no summary path was set" };
  try {
    writeFileSync(path, JSON.stringify(summary, null, 2), "utf8");
    return { written: true, why: "written" };
  } catch (err) {
    return { written: false, why: String(err) };
  }
}

/** Write the verdict as a command ends, and say on stderr when it could not land. */
export function recordRunSummary(path: string, summary: RunSummary): void {
  const res = writeRunSummary(path, summary);
  if (path && !res.written) console.error(`  (the verdict could not be recorded: ${res.why})`);
}

/**
 * Hand a reporter's CONCLUDED to the workflow, whose stamp step reads it. Written whatever became
 * of the Slack post: whether a check concluded is a fact about the run, and losing it to a Slack
 * fault would leave the heartbeat unstamped for a reason unrelated to the check (L53). Does
 * nothing outside a workflow.
 */
export function writeConcludedOutput(concluded: boolean): void {
  const out = process.env.GITHUB_OUTPUT;
  if (out) appendFileSync(out, `concluded=${concluded ? "1" : "0"}\n`, "utf8");
}

/** The alert a scheduled proof posts: its headline, the command's own sentence, how often it
 *  repeats, and where to look (L41: the wording of each part lives with its proof). */
export function proofAlertText(headline: string, summary: RunSummary, silence: string, look: string): string {
  return [headline, summary.detail.trim() || `The run recorded no detail (exit ${summary.exit}).`, silence, look].join("\n");
}

/**
 * The verdict the command wrote, or null when none reached this process. Absent,
 * unreadable and malformed are deliberately one answer: each means the run has to be
 * looked at, and the reporter says so. A missing or non numeric exit is NOT defaulted,
 * because a default would borrow some other ending's meaning.
 */
export function readRunSummary(path: string): RunSummary | null {
  if (!path.trim()) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const { exit, detail } = parsed as Record<string, unknown>;
    if (typeof exit !== "number" || !Number.isFinite(exit)) return null;
    return { exit, detail: typeof detail === "string" ? detail : "" };
  } catch {
    return null;
  }
}
