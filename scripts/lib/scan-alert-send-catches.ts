/**
 * Scanner for an alert send whose failure is caught and DROPPED (#3098).
 *
 * `scan-bare-catches.ts` allows a bare catch on a notifier, and that half is
 * right: a monitoring failure must never become a booking failure. What it let
 * through is the other half. `sendThrottledAlert` throws ON PURPOSE when a key is
 * misconfigured (a missing cooldown, #2656), so the mistake pages nobody but at
 * least lands somewhere, and a database error inside its cooldown read throws the
 * same way. A `.catch(() => {})` on the send drops both with no line anywhere, so
 * the one guard written to make a broken alert visible was defeated at every call
 * site that wrapped it.
 *
 * So a send may still be caught, but the handler must RECORD the failure:
 * `.catch(logAlertSendFailure(key))` or `.catch(logAllClearFailure(keys))` from
 * `@/lib/notify/send-failure`, or any handler that takes the error. What is refused is
 * a handler with no parameter at all, which by construction cannot see the error
 * it is discarding.
 *
 * The callee is found by matching the call's parentheses BACKWARD from the
 * `.catch`, not by walking back to a statement boundary, because a batched
 * all-clear (`resolveRecovered([{ key, text }])`) carries braces inside its own
 * argument list and a boundary walk stops inside it and never sees the name.
 *
 * The escape hatch is `// alert-swallow-ok: <why>` on, or in the comment block
 * directly above, the line holding the `.catch`.
 */
import { blankStringContents } from "./scan-bare-catches.ts";
import { hasOptOut } from "./opt-out.ts";

/** The sends a silent catch is refused on. */
export const ALERT_SEND_CALLEES = ["sendThrottledAlert", "resolveRecovered"] as const;

export const ALERT_SWALLOW_OPT_OUT = "alert-swallow-ok:";

/** A catch handler that takes no parameter, so it cannot see what it drops. */
const SILENT_CATCH =
  /\.catch\(\s*(?:async\s*)?\(\s*\)\s*=>\s*(?:\{\s*\}|\[\s*\]|null|undefined|false|void 0)\s*\)/g;

export interface AlertSendCatchFinding {
  line: number;
  callee: string;
}

/**
 * The identifier called by the parenthesised argument list that closes at
 * `close`, or null when `close` is not a call's closing paren.
 */
function calleeEndingAt(code: string, close: number): string | null {
  if (code[close] !== ")") return null;
  let depth = 0;
  let i = close;
  for (; i >= 0; i--) {
    const c = code[i];
    if (c === ")" || c === "]" || c === "}") depth++;
    else if (c === "(" || c === "[" || c === "{") {
      depth--;
      if (depth === 0) break;
    }
  }
  if (i < 0 || code[i] !== "(") return null;
  let j = i - 1;
  while (j >= 0 && /\s/.test(code[j]!)) j--;
  const end = j + 1;
  while (j >= 0 && /[\w$]/.test(code[j]!)) j--;
  const name = code.slice(j + 1, end);
  return name.length > 0 ? name : null;
}

export function scanAlertSendCatches(source: string): AlertSendCatchFinding[] {
  const code = blankStringContents(source);
  const lines = source.split("\n");
  const findings: AlertSendCatchFinding[] = [];
  for (const m of code.matchAll(SILENT_CATCH)) {
    const at = m.index!;
    let k = at - 1;
    while (k >= 0 && /\s/.test(code[k]!)) k--;
    const callee = calleeEndingAt(code, k);
    if (!callee || !(ALERT_SEND_CALLEES as readonly string[]).includes(callee)) continue;
    const lineIdx = code.slice(0, at).split("\n").length - 1;
    if (hasOptOut(lines, lineIdx, ALERT_SWALLOW_OPT_OUT)) continue;
    findings.push({ line: lineIdx + 1, callee });
  }
  return findings;
}
