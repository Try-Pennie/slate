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

/**
 * The sends a silent catch is refused on: every sender that goes through the
 * `alert_state` cooldown gate in `@/lib/notify/dispatch`, by name.
 */
export const ALERT_SEND_CALLEES = [
  "sendThrottledAlert",
  "sendThrottledInfo",
  "resolveAlert",
  "resolveRecovered",
] as const;

/**
 * The same senders reached through an INJECTED seam (`deps.notify(...)`, a
 * `ThrottledNotify` or `AlertResolve`), which a scan by callee name alone cannot
 * see (#3098 review, L247): the pure monitor checks are handed the dispatcher and
 * call it by the dependency's own name. Matched by the naming convention every
 * such seam already follows, the one `scan-bare-catches.ts` keys on, so the next
 * seam is covered by construction. The suffix must start with a capital, so
 * `resolverFor` is not a sender.
 */
export const INJECTED_SENDER = /^(?:notify|info|resolve|clearAlert|sendAlert)(?:[A-Z][A-Za-z]*)?$/;

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
function calleeEndingAt(
  code: string,
  close: number,
): { name: string; receiver: string | null } | null {
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
  if (name.length === 0) return null;
  // A member call: read the receiver, so `Promise.resolve(...)` is not a seam.
  while (j >= 0 && /\s/.test(code[j]!)) j--;
  if (code[j] !== ".") return { name, receiver: null };
  j--;
  while (j >= 0 && /\s/.test(code[j]!)) j--;
  const rEnd = j + 1;
  while (j >= 0 && /[\w$]/.test(code[j]!)) j--;
  return { name, receiver: code.slice(j + 1, rEnd) || "?" };
}

/** Whether a call is an alert send, direct or through an injected seam. */
export function isAlertSender(name: string, receiver: string | null): boolean {
  if ((ALERT_SEND_CALLEES as readonly string[]).includes(name)) return true;
  return receiver !== null && receiver !== "Promise" && INJECTED_SENDER.test(name);
}

export function scanAlertSendCatches(source: string): AlertSendCatchFinding[] {
  const code = blankStringContents(source);
  const lines = source.split("\n");
  const findings: AlertSendCatchFinding[] = [];
  for (const m of code.matchAll(SILENT_CATCH)) {
    const at = m.index!;
    let k = at - 1;
    while (k >= 0 && /\s/.test(code[k]!)) k--;
    const call = calleeEndingAt(code, k);
    if (!call || !isAlertSender(call.name, call.receiver)) continue;
    const callee = call.receiver ? `${call.receiver}.${call.name}` : call.name;
    const lineIdx = code.slice(0, at).split("\n").length - 1;
    if (hasOptOut(lines, lineIdx, ALERT_SWALLOW_OPT_OUT)) continue;
    findings.push({ line: lineIdx + 1, callee });
  }
  return findings;
}
