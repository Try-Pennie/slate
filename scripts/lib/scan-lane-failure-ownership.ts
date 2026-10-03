/**
 * Scanner for a cron lane failure that could produce TWO messages, or none
 * (#3133 follow-up; Dan, 2026-10-03: "I only want one alert").
 *
 * The dispatcher pages `cron_lane_failed:<lane>` unless the lane's 500 carries the
 * header saying the lane already raised its own alert. That header is written only
 * by `laneFailure` / `laneFailedResponse`, from what the lane's own alerting
 * recorded, so two things have to hold in every lane route, and this refuses both:
 *
 *   - RAW: a deliberate 5xx built by hand. It carries no header however the lane
 *     alerted, so a lane that paged in its catch would page twice.
 *   - OUTSIDE: an alert send or failure streak inside a `catch` block that is not
 *     inside a `laneFailure(...)` call's arguments. It raises the lane's own alert
 *     where nothing records it, so the generic page goes out as well.
 *
 * Text based, like the other convention scanners, on the string and comment blanked
 * copy so a brace in alert copy cannot move a block boundary.
 */
import { blankStringContents } from "./scan-bare-catches.ts";

/** Calls that raise a lane's own alert about its failure, or decide to stay quiet. */
export const OWN_ALERTING_CALL =
  /\b(?:sendThrottledAlert|sendThrottledInfo|recordFailureStreak|recordConsecutiveStreak)\s*\(/g;

/** A hand built 5xx, literal or chosen by a conditional. */
const RAW_5XX = /status:\s*(?:[^,}\n]*\?\s*)?5\d\d\b/g;

export interface OwnershipFinding {
  kind: "raw" | "outside";
  line: number;
}

function lineAt(code: string, index: number): number {
  return code.slice(0, index).split("\n").length;
}

/** Index of the bracket closing the one opened at `open`. */
function closing(code: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  const want = pairs[code[open]!];
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i]!;
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") {
      depth--;
      if (depth === 0) return c === want ? i : -1;
    }
  }
  return -1;
}

export function scanLaneFailureOwnership(source: string): OwnershipFinding[] {
  const code = blankStringContents(source);
  const findings: OwnershipFinding[] = [];

  for (const m of code.matchAll(RAW_5XX)) {
    findings.push({ kind: "raw", line: lineAt(code, m.index!) });
  }

  // Argument ranges of every laneFailure(...) call.
  const owned: [number, number][] = [];
  for (const m of code.matchAll(/\blaneFailure\s*\(/g)) {
    const open = m.index! + m[0].length - 1;
    owned.push([open, closing(code, open)]);
  }

  // The body of every `catch (...) { ... }` (not a `.catch(` handler).
  for (const m of code.matchAll(/(?<![.\w])catch\s*(?:\([^)]*\))?\s*\{/g)) {
    const open = m.index! + m[0].length - 1;
    const close = closing(code, open);
    if (close < 0) continue;
    const body = code.slice(open, close);
    for (const call of body.matchAll(OWN_ALERTING_CALL)) {
      const at = open + call.index!;
      if (!owned.some(([a, b]) => at > a && at < b)) {
        findings.push({ kind: "outside", line: lineAt(code, at) });
      }
    }
  }
  return findings.sort((a, b) => a.line - b.line);
}
