/**
 * Scanner for `.catch(() => {})` on REAL WORK (#1049).
 *
 * A bare catch is not automatically wrong. Slate has ~56 of them that are
 * deliberate and correct: every alert send is wrapped in one, because a
 * monitoring failure must never become a booking failure. Those are fine.
 *
 * What is NOT fine is a bare catch on work the product depends on. Those leave
 * ZERO forensic trace: a push-triggered sync, a time-off approval, an event
 * deletion enqueue, a slot recompute or a reservation cleanup can fail on every
 * single attempt and nothing anywhere records that it happened. There is no log
 * line to search, no alert, no counter. The 2026-07-23 audit found five such
 * sites and estimated ~30 bare catches total; there were 69, and two of the
 * real-work ones it had not spotted were a Slack OOO approve/reject (an approval
 * silently vanishing) and enqueueEventDeletion (a Google event orphaned forever).
 *
 * The rule this encodes: a bare catch is allowed when the thing it wraps is a
 * NOTIFICATION, and otherwise must either carry a real handler that logs, or an
 * explicit `// swallow-ok:` opt-out saying why losing the error is safe.
 *
 * Deliberately a text scan, not a parse: the shape is unambiguous and the
 * codebase's other convention guards (scan-capped-reads, scan-swallowed-error-reads)
 * are built the same way, so this stays cheap and readable.
 */

/** Calls whose failure is genuinely fine to drop: telling someone FAILED, which
 *  must not escalate into breaking the operation that was being reported. */
import { hasOptOut } from "./opt-out.ts";

export const NOTIFIER_CALLS = [
  "sendThrottledAlert",
  "sendThrottledInfo",
  "resolveAlert",
  "resolveRecovered",
  "recordHeartbeat",
  "reportCompletionSaturation",
  "reportDeletionSaturation",
];

/**
 * Injected notifier seams on the monitor lanes' dependency objects.
 *
 * A PATTERN rather than a list of exact names, because a list can only recognise
 * the seams someone remembered to add, and the one that is missing is exactly the
 * one whose swallowed failure nobody notices (L96). Naming a dep `notifyX` or
 * `resolveX` is the existing convention on every one of these lanes, so deriving
 * from the convention covers the next one by construction. #1288's
 * `notifyCountUnreadable` / `resolveCountUnreadable` were the instance that showed
 * an enumeration was the wrong shape.
 *
 * The suffix must start with a CAPITAL, so `resolveCountUnreadable` matches while
 * `resolverForAgent` does not. A shape filter has to be tested against what it
 * must PRESERVE, not only against what it must catch (L104), and a bare
 * `[A-Za-z]*` here would have excused any real-work dep whose name happens to
 * begin with one of these words.
 */
export const NOTIFIER_SEAM_RE =
  /\.(?:notify|info|resolve|clearAlert|sendAlert)(?:[A-Z][A-Za-z]*)?\(/;

export const OPT_OUT = "swallow-ok:";

export interface BareCatchFinding {
  line: number;
  /** The statement the catch is attached to, collapsed to one line. */
  statement: string;
  /** True when this is a notifier send or carries the opt-out. */
  allowed: boolean;
}

const BARE_CATCH = ".catch(() => {})";

/**
 * Blank the CONTENTS of every string and template literal, preserving length and
 * newlines so every index still maps 1:1 onto the original source.
 *
 * Needed because the walk-back below keys on `;` `{` `}`, and Slate's alert copy
 * is full of them: an interpolated template like
 * `` `... (${shortFailureReason(e)}). The agent may keep ...` `` contains braces,
 * which truncated the walk-back mid-string and hid the real callee. Five
 * deliberate notifier sends were flagged as real work for exactly that reason.
 */
export function blankStringContents(src: string): string {
  const out = src.split("");
  let i = 0;
  while (i < out.length) {
    const c = out[i];

    // COMMENTS FIRST, and this order is load-bearing. Handling quotes first
    // meant an ordinary apostrophe in prose ("doesn't", "agent's") opened a fake
    // string that ran until the next apostrophe hundreds of lines later, blanking
    // real code in between. That hid three genuine offenders (a Slack OOO
    // approve/reject and an event-deletion enqueue) and the scan still reported
    // a confident-looking result, which is the false-negative shape this repo
    // keeps getting bitten by.
    if (c === "/" && out[i + 1] === "/") {
      let j = i + 2;
      while (j < out.length && out[j] !== "\n") {
        out[j] = " ";
        j++;
      }
      i = j;
      continue;
    }
    if (c === "/" && out[i + 1] === "*") {
      let j = i + 2;
      while (j < out.length && !(out[j] === "*" && out[j + 1] === "/")) {
        if (out[j] !== "\n") out[j] = " ";
        j++;
      }
      i = j + 2;
      continue;
    }

    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      let j = i + 1;
      while (j < out.length) {
        if (out[j] === "\\") {
          j += 2;
          continue;
        }
        if (out[j] === quote) break;
        // A single/double quoted string cannot span a newline: if we hit one, the
        // quote was not an opener (an unescaped apostrophe in a template, say),
        // so stop rather than blanking the rest of the file.
        if (out[j] === "\n" && quote !== "`") break;
        if (out[j] !== "\n") out[j] = " ";
        j++;
      }
      i = j + 1;
      continue;
    }
    i++;
  }
  return out.join("");
}

/**
 * Walk back from `at` to the start of the enclosing statement, so the callee is
 * visible even when the call spans several lines (the common shape: a multi-line
 * `sendThrottledAlert(...)` whose `.catch` sits on the closing paren's line).
 */
function statementStart(src: string, at: number): number {
  for (let i = at; i > 0; i--) {
    const c = src[i];
    if (c === ";" || c === "{" || c === "}") return i + 1;
  }
  return 0;
}

export function scanBareCatches(source: string): BareCatchFinding[] {
  const lines = source.split("\n");
  // All index math runs on the string-blanked copy so a brace inside alert copy
  // cannot truncate the walk-back; the ORIGINAL lines are used for reporting and
  // for reading the opt-out comment.
  const code = blankStringContents(source);
  const findings: BareCatchFinding[] = [];

  let from = 0;
  for (;;) {
    const at = code.indexOf(BARE_CATCH, from);
    if (at === -1) break;
    from = at + BARE_CATCH.length;

    const lineIdx = code.slice(0, at).split("\n").length - 1;
    const rawLine = lines[lineIdx] ?? "";

    // A mention inside a comment (this file's own prose, or a doc comment
    // describing the pattern) is not a call site.
    const trimmed = rawLine.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

    const statement = code
      .slice(statementStart(code, at), at)
      .replace(/\s+/g, " ")
      .trim();

    const isNotifier =
      NOTIFIER_CALLS.some((n) => statement.includes(n)) || NOTIFIER_SEAM_RE.test(statement);
    const optedOut = hasOptOut(lines, lineIdx, OPT_OUT);

    findings.push({
      line: lineIdx + 1,
      statement: statement.slice(-140),
      allowed: isNotifier || optedOut,
    });
  }

  return findings;
}

/** The findings that should fail the build: real work, silently discarded. */
export function offendingBareCatches(source: string): BareCatchFinding[] {
  return scanBareCatches(source).filter((f) => !f.allowed);
}
