// The smoke canary's failure message, and the checks it names (#525, #1492, #3801).
//
// One builder for one message, wherever it is posted from: the bare node alerter
// (`scripts/notify-smoke-failure.ts`) builds it, hands it to the Worker so it posts
// through the same throttle as every other condition, and posts it directly only
// when that handoff fails. The alert preview renders it through this same function,
// which is why it lives here and imports nothing but a type: the alerter runs with
// NO dependency install (AGENTS.md, "An alerting workflow carries no dependency
// install"), and `scripts/test-dependency-free-scripts.ts` walks this file too.
import type { FailureLog } from "./smoke-failure-log.ts";

export interface SmokeFailureContext {
  /** Which pass ran: "full" (real bookings) or "dry" (side effect free tick). */
  mode: string;
  runUrl: string;
  /** What the run recorded as failing, so the alert can name its own cause (#1492). */
  failures: FailureLog;
}

/**
 * How many failed checks to name in the message. A canary failure is usually one or
 * two checks; a broken deploy can fail every one of them, and thirty lines on a phone
 * mid incident is the #1133 wall of text again. The rest are pointed at, not pasted.
 */
const NAMED_FAILURE_CAP = 6;

/** One failed check without its log prefix. */
function checkText(line: string): string {
  return line.replace(/^FAIL:\s*/i, "").trim();
}

/** One failed check, trimmed so a long detail cannot push the run link off screen. */
function failureLine(line: string): string {
  const clean = checkText(line);
  if (clean.length <= 160) return `- ${clean}`;
  // Truncate on a word boundary, never mid word: #1133 shipped "mess" as a line
  // ending and that is what made the page unreadable.
  const cut = clean.slice(0, 160);
  const at = cut.lastIndexOf(" ");
  return `- ${(at > 80 ? cut.slice(0, at) : cut).trimEnd()}...`;
}

export function buildSmokeFailureMessage(ctx: SmokeFailureContext): string {
  const pass =
    ctx.mode === "full"
      ? "full end to end booking smoke"
      : "booking smoke health check";
  // Not opened with "Slate" (#3801): it now posts through the Worker like every other
  // alert, under Slate's own app name, and the preview guard holds every alert to that.
  const head = `Booking canary failed: the ${pass} did not pass against production.`;

  // The whole point of #1492: say WHICH checks failed, so the reader can tell a
  // fixture collision from a booking outage without a code read and a production
  // query. The three states are genuinely different situations and get different
  // second lines, never one sentence covering every cause.
  if (ctx.failures.kind === "failures") {
    const named = ctx.failures.lines.slice(0, NAMED_FAILURE_CAP).map(failureLine);
    const rest = ctx.failures.lines.length - named.length;
    const more = rest > 0 ? `\n(and ${rest} more in the run)` : "";
    const count =
      ctx.failures.lines.length === 1 ? "1 check failed" : `${ctx.failures.lines.length} checks failed`;
    return [`${head} ${count}:`, named.join("\n") + more, ctx.runUrl].join("\n");
  }
  if (ctx.failures.kind === "unreadable") {
    return [
      `${head} Which checks failed could not be read (${ctx.failures.reason}), so the run itself is the only record.`,
      ctx.runUrl,
    ].join("\n");
  }
  // No check reported at all. That is not "nothing failed": it means the run died
  // before any check ran, which is what an unparseable base URL or a missing key
  // looks like, and it points somewhere different from a failed check.
  return [
    `${head} No check reported a result, so the run stopped before the checks began: look for a crash, a missing key, or a misconfigured base URL rather than a booking regression.`,
    ctx.runUrl,
  ].join("\n");
}

/**
 * The checks this failure names, handed to the Worker as the page's subjects (#3801).
 * A check not named in the last post is a change and posts at once; the same failing
 * checks are said again once a day. The Worker strips every number from each, so a
 * slow read reported as 4,210ms and then 4,380ms is the same check. A run that
 * reported nothing, or whose record could not be read, is one subject of its own,
 * since either is a different problem from a failed check.
 */
export function smokeFailureChecks(failures: FailureLog): string[] {
  if (failures.kind === "failures") return failures.lines.map(checkText).filter((l) => l !== "");
  if (failures.kind === "unreadable") return ["the failed checks could not be read"];
  return ["no check reported a result"];
}
