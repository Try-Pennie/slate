// Static detector for the #1135 guard: a raw error value interpolated into alert
// copy without going through the shared formatter. The fixtures and the real-tree
// run live in scripts/test-alert-error-text.ts.
//
// The bug class. On 2026-07-28 a sync-failure page arrived as eight lines of
// Google's pretty-printed JSON, cut off mid-word at `"mess` by a fixed-width
// slice. It was unreadable on a phone, which is where these are read, and the one
// fact worth having (a 503 backendError that self-healed) was buried. #1133 fixed
// that alert and left `shortFailureReason` behind; #1135 swept the rest and found
// the same shape in seven more places, including the chokepoint that reports EVERY
// unexpected server fault.
//
// The reason it kept reappearing is that each alert formats its own message by
// hand, so "put the error in the text" is a decision re-made at every call site,
// and the wrong version (`${err.message}`, `String(e).slice(0, 200)`) is shorter to
// type than the right one. This makes the wrong version fail the build.
//
// WHAT IS FLAGGED: an argument to sendThrottledAlert / sendThrottledInfo /
// resolveAlert whose template literal interpolates an error-shaped expression:
//
//   `... failed (${error.message}) ...`        <- flagged
//   `... failed: ${String(e).slice(0, 200)}`   <- flagged
//   `... (${err}) ...`                         <- flagged
//   `... (${shortFailureReason(error.message)})` <- fine, routed
//   `... (${shortErrorReason(e)})`               <- fine, routed
//
// It also follows ONE hop through a local binding, because the worst instance in
// the tree took that form: `reportInternalError` built
// `const detail = (err instanceof Error ? err.message : String(err)).slice(0, 300)`
// and then interpolated `${detail}`. A first cut of this scanner missed it, which
// is the whole reason the hop is here: the chokepoint that reports every
// unexpected server fault is exactly the place a guard must not have a blind spot.
// So a `const` in the same file whose initialiser is error-shaped marks that name
// as error-shaped too.
//
// SCOPE (deliberate, stated so this never reads as more coverage than it has):
// one hop, same file, `const` only. A message assembled across several statements,
// reassigned, or passed in as a parameter is NOT followed. Chasing those needs a
// real parser, and a scanner that half-follows data flow while implying it follows
// all of it is worse than one with an honest boundary.
//
// THE ESCAPE HATCH is `// alert-text-ok: <why>` on, or in the `//` block directly
// above, the flagged line, for copy that deliberately carries an error-shaped
// value which is already short and human (an internally built reason string).

/** Interpolations that are already routed through the shared formatter. */
const ROUTED = /\b(?:shortFailureReason|shortErrorReason)\s*\(/;

/**
 * Error-shaped expressions. Deliberately narrow: named error bindings, a
 * `.message`, and the stringify-then-slice idiom. Matching anything broader (any
 * identifier at all) would flood the scan with false positives and get the guard
 * disabled, which is worse than the gap.
 */
const ERROR_SHAPED = [
  /\berr(?:or)?\b\s*(?:\?\.)?\s*$/, // a bare `err` / `error` interpolation
  /\.\s*message\b/, // anything's `.message`
  /\bString\s*\(\s*e(?:rr(?:or)?)?\s*\)/, // String(e) / String(err)
  /\b(?:err|error|e)\s*\?\?/, // `err ?? "no detail"`
  /\.\s*(?:last_)?error\b/, // health.error, row.last_error
];

const ALERT_CALL = /\b(?:sendThrottledAlert|sendThrottledInfo|resolveAlert)\s*\(/g;

export interface AlertTextFinding {
  line: number;
  text: string;
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === "\n") line++;
  }
  return line;
}

/** `// alert-text-ok:` on the line, or in the `//` block directly above it. */
function hasOptOut(source: string, index: number): boolean {
  const lines = source.slice(0, index).split("\n");
  const own = lines[lines.length - 1] ?? "";
  if (/\/\/\s*alert-text-ok/i.test(own)) return true;
  for (let i = lines.length - 2; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed.startsWith("//")) break;
    if (/\/\/\s*alert-text-ok/i.test(trimmed)) return true;
  }
  return false;
}

/** The source span of the call's argument list, from `(` to its matching `)`. */
function callSpan(source: string, openParen: number): [number, number] {
  let depth = 0;
  for (let i = openParen; i < source.length; i++) {
    const c = source[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return [openParen, i];
    }
  }
  return [openParen, source.length];
}

/**
 * Every `${...}` interpolation inside template literals in `span`, as
 * [sourceIndex, expression] pairs. Nested braces inside the expression (an object
 * literal, a nested template) are balanced so the expression is not cut short.
 */
function interpolations(span: string, offset: number): [number, string][] {
  const out: [number, string][] = [];
  for (let i = 0; i < span.length - 1; i++) {
    if (span[i] !== "$" || span[i + 1] !== "{") continue;
    let depth = 1;
    let j = i + 2;
    for (; j < span.length && depth > 0; j++) {
      if (span[j] === "{") depth++;
      else if (span[j] === "}") depth--;
    }
    out.push([offset + i, span.slice(i + 2, j - 1)]);
    i = j - 1;
  }
  return out;
}

/** `const NAME = <initialiser>` declarations, to the end of the line. */
const CONST_DECL = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*([^\n]*)/g;

/**
 * Local names bound to an error-shaped expression, so `${detail}` is judged by
 * what `detail` holds. One hop only: an initialiser that is itself a plain name is
 * not chased further.
 */
function errorShapedLocals(source: string): Set<string> {
  const names = new Set<string>();
  CONST_DECL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CONST_DECL.exec(source)) !== null) {
    const [, name, init] = m;
    if (ROUTED.test(init)) continue;
    if (ERROR_SHAPED.some((re) => re.test(init))) names.add(name);
  }
  return names;
}

/**
 * Flag every raw-error interpolation in this file's alert copy.
 *
 * Reports the LINE of the offending interpolation (not the call), because that is
 * where the fix goes.
 */
export function scanAlertErrorText(source: string, _path = ""): AlertTextFinding[] {
  const findings: AlertTextFinding[] = [];
  const errorLocals = errorShapedLocals(source);
  ALERT_CALL.lastIndex = 0;
  let call: RegExpExecArray | null;
  while ((call = ALERT_CALL.exec(source)) !== null) {
    const openParen = source.indexOf("(", call.index);
    if (openParen === -1) continue;
    const [start, end] = callSpan(source, openParen);
    for (const [index, expr] of interpolations(source.slice(start, end), start)) {
      if (ROUTED.test(expr)) continue;
      const isLocal = errorLocals.has(expr.trim());
      if (!isLocal && !ERROR_SHAPED.some((re) => re.test(expr))) continue;
      if (hasOptOut(source, index)) continue;
      findings.push({ line: lineOf(source, index), text: expr.trim() });
    }
  }
  return findings;
}
