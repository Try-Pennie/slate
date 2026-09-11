/**
 * Which Google calendar calls the booking path can make, and whether each is
 * gated behind `SLATE_LOADTEST` (#2241).
 *
 * The load-test stub covered the read and watch lanes and nothing else, so a
 * booking path run could not confirm one booking: `completeReservation` calls
 * `createEvent` live. The reason it stayed invisible for a year is that nothing
 * connected the two files. Somebody adding a Google call to `realDeps` had no way
 * to be told the stub did not know about it.
 *
 * So the list is DERIVED rather than maintained (L96): it is the set of
 * `calendar.ts` exports that `realDeps` in `src/lib/booking/service.ts` actually
 * names. A hand written registry would be exempt from the guard meant to catch
 * exactly what somebody forgot to add to it.
 *
 * Pure over two file contents, so the rule is testable against synthetic sources
 * as well as against the real tree.
 */

export interface CalendarExport {
  name: string;
  /** The function body, brace matched from its signature. */
  body: string;
}

export type CoverageReason =
  | "gated"
  | "delegates"
  /** Reached, makes its own Google request, and has no gate: the defect. */
  | "ungated"
  /** Reached, no gate, and every calendar export it calls is itself ungated. */
  | "delegates-to-ungated"
  /** Reached, no gate, no Google request, and calls nothing this can follow. */
  | "opaque";

export interface CoverageRow {
  name: string;
  reason: CoverageReason;
  /** The calendar exports this one calls, for the message. */
  calls: string[];
}

export interface StubCoverage {
  /** Every `calendar.ts` export `realDeps` names, sorted. */
  reached: string[];
  rows: CoverageRow[];
  /** Rows that are not covered, in `reached` order. The failure list. */
  uncovered: CoverageRow[];
  /**
   * The same judgement for EVERY export, reached or not. Nothing fails on it;
   * it exists so a control can watch an export the booking path does not
   * currently reach (a gate removed from `freeBusy` must take `isFree` down with
   * it, and `isFree` is reached from elsewhere in the file).
   */
  all: CoverageRow[];
}

/** Covered means: no live Google request can escape from here under the flag. */
const COVERED: ReadonlySet<CoverageReason> = new Set<CoverageReason>(["gated", "delegates"]);

/**
 * Where a function's body opens, given the offset just past the opening paren of
 * its parameter list.
 *
 * Not "the next `{`", which was the first version and was wrong on two of the
 * five functions this guard exists for: `deleteEvent(…, opts?: { notifyAttendee?:
 * boolean })` and `updateEventContact(…, patch: { … })` both carry a brace inside
 * the parameter list, so the "body" was an object TYPE, which contains neither
 * the gate nor the request and read as a function doing nothing at all. So: match
 * the parameter parens, then take the first brace outside any `<…>`, which is
 * what keeps `Promise<{ … }>` from answering instead.
 */
function bodyStart(source: string, afterOpenParen: number): number {
  let depth = 1;
  let i = afterOpenParen;
  for (; i < source.length && depth > 0; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")") depth--;
  }
  if (depth !== 0) return -1;
  let angle = 0;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === "<") angle++;
    else if (ch === ">") angle = Math.max(0, angle - 1);
    else if (ch === "{" && angle === 0) return i;
    else if (ch === ";") return -1; // a declaration with no body
  }
  return -1;
}

/**
 * Every exported function in a module, with its body taken by matching braces
 * from the signature.
 *
 * Brace matching rather than "text up to the next export", because the text
 * between two functions is the SECOND one's doc comment: attributing it to the
 * first would let a comment mentioning `LOADTEST` read as a gate on the function
 * above it, which is the one mistake a scanner like this must not make.
 */
export function calendarExports(source: string): CalendarExport[] {
  const out: CalendarExport[] = [];
  const sig = /export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = sig.exec(source)) !== null) {
    const open = bodyStart(source, sig.lastIndex);
    if (open === -1) continue;
    let depth = 0;
    let end = -1;
    for (let i = open; i < source.length; i++) {
      const ch = source[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    // An unbalanced body is reported as EMPTY rather than as the rest of the
    // file: a body silently swallowing every later function would make one gate
    // answer for all of them.
    out.push({ name: m[1]!, body: end === -1 ? "" : source.slice(open, end + 1) });
  }
  return out;
}

/** The names `src/lib/booking/service.ts` imports from the calendar module. */
export function calendarImports(serviceSource: string): string[] {
  const m = /import\s*\{([^}]*)\}\s*from\s*"@\/lib\/google\/calendar"/.exec(serviceSource);
  if (!m) return [];
  return m[1]!
    .split(",")
    .map((s) => s.trim().split(/\s+as\s+/)[0]!.trim())
    .filter((s) => s.length > 0 && s !== "type");
}

/** The body of a named top level function, brace matched. */
export function functionBody(source: string, name: string): string | null {
  const re = new RegExp(`function\\s+${name}\\s*\\(`);
  const m = re.exec(source);
  if (!m) return null;
  const open = source.indexOf("{", m.index + m[0].length);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return null;
}

function mentions(body: string, name: string): boolean {
  return new RegExp(`\\b${name}\\b`).test(body);
}

/**
 * Judge every calendar export `realDeps` reaches.
 *
 * `realDepsName` is a parameter so a rename in `service.ts` is a test failure
 * rather than a scanner that quietly finds nothing (an empty reached list and a
 * fully covered tree are the same clean result, L98; the caller asserts the list
 * is non-empty).
 */
export function stubCoverage(
  serviceSource: string,
  calendarSource: string,
  realDepsName = "realDeps",
): StubCoverage {
  const exports = calendarExports(calendarSource);
  const byName = new Map(exports.map((e) => [e.name, e]));
  const deps = functionBody(serviceSource, realDepsName) ?? "";
  const imported = calendarImports(serviceSource);
  const reached = imported.filter((n) => byName.has(n) && mentions(deps, n)).sort();

  const callsOf = (e: CalendarExport): string[] =>
    exports
      .filter((o) => o.name !== e.name && new RegExp(`\\b${o.name}\\s*\\(`).test(e.body))
      .map((o) => o.name);

  const gated = new Set(exports.filter((e) => mentions(e.body, "LOADTEST")).map((e) => e.name));
  // `gfetch` is the module's ONE authenticated request helper, so a body naming
  // it is a body that can reach Google.
  const requests = new Set(exports.filter((e) => mentions(e.body, "gfetch")).map((e) => e.name));

  // A small fixpoint rather than one pass: `eventExists` delegates to
  // `getEventOnPrimary`, and a chain one hop longer must resolve the same way.
  const covered = new Set(gated);
  for (let pass = 0; pass < exports.length; pass++) {
    let grew = false;
    for (const e of exports) {
      if (covered.has(e.name)) continue;
      const calls = callsOf(e);
      if (calls.length > 0 && !requests.has(e.name) && calls.every((c) => covered.has(c))) {
        covered.add(e.name);
        grew = true;
      }
    }
    if (!grew) break;
  }

  const judge = (name: string): CoverageRow => {
    const e = byName.get(name)!;
    const calls = callsOf(e);
    let reason: CoverageReason;
    if (gated.has(name)) reason = "gated";
    else if (covered.has(name)) reason = "delegates";
    else if (requests.has(name)) reason = "ungated";
    else if (calls.length > 0) reason = "delegates-to-ungated";
    else reason = "opaque";
    return { name, reason, calls };
  };

  const rows: CoverageRow[] = reached.map(judge);

  return {
    reached,
    rows,
    uncovered: rows.filter((r) => !COVERED.has(r.reason)),
    all: exports.map((e) => judge(e.name)),
  };
}
