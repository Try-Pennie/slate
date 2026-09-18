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
// It also looks ONE HOP INTO A BUILDER ARGUMENT (#2418), because the alert copy
// this repo writes now lives in pure builders and the raw value is handed to one
// as an ordinary argument:
//
//   sendThrottledAlert(key, MS, webhookDeadAlert(url, event, n, lastResponse))
//
// The send site passes a function call, so there is no template here to read, and
// the builder interpolates a PARAMETER, whose name says nothing about what it
// holds. Both halves look clean while a kilobyte of a subscriber's HTML block page
// goes to Slack, which is exactly what #2418 found. So every top-level argument of
// the alert call, and every top-level argument of a call sitting AT an argument
// position of it, is judged the same way an interpolation is.
//
// SCOPE (deliberate, stated so this never reads as more coverage than it has):
// one hop for the binding, one hop for the builder, same file. A message assembled
// across several statements, or a builder reached through a variable rather than
// called by name at the send site, is NOT followed. Chasing those needs a real
// parser, and a scanner that half-follows data flow while implying it follows all
// of it is worse than one with an honest boundary.
//
// THE ESCAPE HATCH is `// alert-text-ok: <why>` on, or in the `//` block directly
// above, the flagged line, for copy that deliberately carries an error-shaped
// value which is already short and human (an internally built reason string).

/** Interpolations that are already routed through the shared formatter. */
import { hasOptOutAtOffset } from "./opt-out.ts";

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

/**
 * Alert COPY BUILDERS (#1153). Alert wording now lives in pure builders so the
 * preview can render it, which moved a lot of text out of the send calls above.
 * Without this, a raw error interpolated inside one of those builders would sit
 * outside the scan entirely: the send site would look clean because it passes a
 * function call, and the text with the error in it would never be examined.
 *
 * Any exported function in a `*alert-copy.ts` / `*-copy.ts` module counts, and so
 * does any exported `format*` / `*AlertText` / `*Message` / `*Notice` builder, so
 * the copy is judged wherever it lives.
 */
const COPY_MODULE = /(?:alert-copy|lane-copy)\.ts$/;

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

/** `// alert-text-ok:` on the line, or in the comment block directly above it. */
function hasOptOut(source: string, index: number): boolean {
  return hasOptOutAtOffset(source, index, "alert-text-ok:");
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

/** `const|let|var NAME = <initialiser>` declarations, to the end of the line. */
const BINDING_DECL = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^\n]*)/g;

/**
 * A LATER assignment to an already-declared name, `lastResponse = String(err)...`.
 *
 * Declarations alone were not enough (#2418). The webhook sender declares
 * `let lastResponse = ""` and fills it in four branches, one of which is
 * `String(err).slice(0, 1000)`, so the name is error-shaped everywhere it is read
 * and nothing about its declaration says so. `=` is required not to be `==` or
 * `=>`, so a comparison and an arrow body are not read as bindings.
 */
const ASSIGNMENT = /(?:^|[;{}\n])[ \t]*([A-Za-z_$][\w$]*)\s*=(?![=>])\s*([^\n]*)/g;

/**
 * Local names bound to an error-shaped expression, so `${detail}` is judged by
 * what `detail` holds. One hop only: an initialiser that is itself a plain name is
 * not chased further.
 *
 * A name counts when ANY of its bindings is error-shaped, because a name that can
 * hold an error on one branch reaches alert copy holding one on that branch. A
 * binding routed through the formatter is not counted, so a name assigned the
 * formatter's output in every branch stays clean.
 */
function errorShapedLocals(source: string): Set<string> {
  const names = new Set<string>();
  for (const re of [BINDING_DECL, ASSIGNMENT]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const [, name, init] = m;
      if (ROUTED.test(init)) continue;
      if (ERROR_SHAPED.some((r) => r.test(init))) names.add(name);
    }
  }
  return names;
}

/** A name followed by `(`, i.e. an expression that is a call to a named function. */
const CALL_EXPR = /^\s*([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\(/;

/**
 * Top-level, comma-separated arguments between `open` and `close`, as
 * [sourceIndex, expression] pairs. Strings, template literals and nested
 * brackets are skipped so a comma inside one never splits an argument.
 */
function splitArguments(source: string, open: number, close: number): [number, string][] {
  const out: [number, string][] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open + 1; i < close; i++) {
    const c = source[i];
    if (c === "'" || c === '"') {
      const quote = c;
      i++;
      while (i < close && source[i] !== quote) {
        if (source[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (c === "`") {
      i++;
      let braces = 0;
      while (i < close) {
        const t = source[i];
        if (t === "\\") i++;
        else if (t === "$" && source[i + 1] === "{") { braces++; i++; }
        else if (t === "}" && braces > 0) braces--;
        else if (t === "`" && braces === 0) break;
        i++;
      }
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      out.push([start, source.slice(start, i)]);
      start = i + 1;
    }
  }
  out.push([start, source.slice(start, close)]);
  return out.filter(([, text]) => text.trim().length > 0);
}

/**
 * Flag every raw-error interpolation in this file's alert copy.
 *
 * Reports the LINE of the offending interpolation (not the call), because that is
 * where the fix goes.
 */
export function scanAlertErrorText(source: string, _path = ""): AlertTextFinding[] {
  const findings: AlertTextFinding[] = [];
  const seen = new Set<string>();
  const errorLocals = errorShapedLocals(source);

  /**
   * One judgement, used for an interpolation and for an argument alike.
   *
   * `anchor` is a SECOND place the opt-out may sit, and it is passed only for an
   * argument-position finding. An argument of a multi-line alert call has an
   * argument list above it rather than a comment block, so the only place the
   * convention leaves for the reason is above the call itself, which is where the
   * authors of the existing ones put it. An interpolation keeps the original rule
   * exactly, so nothing already flagged becomes exempt.
   */
  const judge = (index: number, raw: string, anchor?: number) => {
    const expr = raw.trim();
    if (!expr) return;
    if (ROUTED.test(expr)) return;
    if (!errorLocals.has(expr) && !ERROR_SHAPED.some((re) => re.test(expr))) return;
    if (hasOptOut(source, index)) return;
    if (anchor !== undefined && hasOptOut(source, anchor)) return;
    const line = lineOf(source, index);
    const key = `${line}:${expr}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ line, text: expr });
  };

  const flag = (start: number, end: number) => {
    for (const [index, expr] of interpolations(source.slice(start, end), start)) {
      judge(index, expr);
    }
  };

  /**
   * The #2418 hop. Judge the alert call's own arguments, and the arguments of any
   * call sitting at one of those positions, which is where a copy builder is
   * reached. An argument holding a template literal is left to `flag`, which
   * reports the interpolation rather than the whole sentence.
   */
  const flagArguments = (open: number, close: number, anchor: number) => {
    for (const [index, arg] of splitArguments(source, open, close)) {
      if (arg.includes("`")) continue;
      judge(index, arg, anchor);
      const callee = CALL_EXPR.exec(arg);
      if (!callee || ROUTED.test(callee[1] + "(")) continue;
      // callee[0] ends at the builder's own `(`, so this is its index in `source`.
      const nestedOpen = index + callee[0].length - 1;
      if (source[nestedOpen] !== "(" || nestedOpen >= close) continue;
      const [nOpen, nClose] = callSpan(source, nestedOpen);
      for (const [nIndex, nArg] of splitArguments(source, nOpen, nClose)) {
        if (nArg.includes("`")) continue;
        judge(nIndex, nArg, anchor);
      }
    }
  };

  ALERT_CALL.lastIndex = 0;
  let call: RegExpExecArray | null;
  while ((call = ALERT_CALL.exec(source)) !== null) {
    const openParen = source.indexOf("(", call.index);
    if (openParen === -1) continue;
    const [start, end] = callSpan(source, openParen);
    flag(start, end);
    flagArguments(start, end, call.index);
  }

  // #1153: a copy module IS alert text, even though it never calls the sender.
  // Scanning the whole file is right here: these modules exist only to build
  // alert wording, so every template in one is a message a human will read.
  if (COPY_MODULE.test(_path)) flag(0, source.length);

  return findings;
}
