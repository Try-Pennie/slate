// Static detector for the #730 guard: a capped single-page PostgREST list read
// used for a count/aggregate. See scripts/test-capped-reads.ts for the why and
// the fixtures that prove this actually catches the bad pattern.
//
// A "read site" is a call whose first argument is a string literal containing
// `select=` (a PostgREST GET). It is FLAGGED when the read's result is consumed
// as a count/aggregate (`.length`, `.filter`, `.reduce`, `.some`, `.every`),
// UNLESS it is cap-safe:
//   - the reader is `listAll` or `count` (the paginating / server-side helpers),
//   - the query string carries `limit=` (an explicit bounded page),
//   - a `// cap-safe:` comment sits on the call's line or the line above.
// A single-row grab (rows[0], no aggregate) is never flagged; it isn't a count.
//
// This is deliberately a text scan, not a full parser: it stays lightweight and
// dependency-free like the other repo-invariant guards, and the escape hatches
// keep it from false-flagging the legitimately-narrow lookups.

import { hasOptOutAtOffset } from "./opt-out.ts";

export interface CappedReadFinding {
  file: string;
  line: number;
  /** The reader function the literal was passed to (e.g. pgGet, getJson, fetch). */
  reader: string;
  /** The `select=` query literal (truncated for readability). */
  query: string;
}

/** Readers that are cap-safe by construction (paginate / count server-side). */
const SAFE_READERS = new Set(["listAll", "count"]);

// <ident>[<generics>] ( <string literal> ...   capturing reader + delimiter + body.
// The literal must be the first argument (true for every read in the scan surface).
// The generic class is restricted to type-token characters (word, whitespace,
// commas, brackets, angles, dots) so a comparison like `i < 6 && ...` (which
// contains operators) is NOT mistaken for a generic that would swallow the real
// call that follows it.
const READ_SITE =
  /(\w+)\s*(?:<[\w\s,[\].<>]*>)?\s*\(\s*(['"`])((?:\\.|(?!\2)[\s\S])*?)\2/g;

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === "\n") line++;
  }
  return line;
}

/**
 * True if a `// cap-safe` opt-out is attached to the read: either a trailing
 * comment on the call's own line, or anywhere in the contiguous block of `//`
 * comment lines immediately above it (so a multi-line justification counts).
 */
function hasOptOut(source: string, callIndex: number): boolean {
  return hasOptOutAtOffset(source, callIndex, "cap-safe:");
}

/**
 * Whether the read's result is consumed as a count/aggregate. Two shapes:
 *   - assigned: `const X = await reader(...)` then `X.length` / `X.filter(...)`
 *     later in the same block (a forward, bounded window to avoid matching a
 *     same-named variable in an unrelated function),
 *   - inline: `(await reader(...)).length` / `.filter(...)`.
 */
function consumedAsAggregate(source: string, callIndex: number, literalEnd: number): boolean {
  // Inline: does an aggregate access immediately follow the call's closing parens?
  const after = source.slice(literalEnd, literalEnd + 80);
  if (/^[)\s]*\.(length|filter|reduce|some|every)\b/.test(after)) return true;

  // Assigned: pull the variable name out of the statement prefix.
  const pre = source.slice(0, callIndex);
  const assign = pre.match(/(?:const|let|var)\s+(\w+)\s*=\s*\(?\s*await\s*$/);
  if (!assign) return false;
  const varName = assign[1];

  // Search a forward window (~50 lines) for that variable used as an aggregate.
  const windowEnd = nthNewline(source, literalEnd, 50);
  const window = source.slice(literalEnd, windowEnd);
  const use = new RegExp(`\\b${varName}\\b\\s*\\.(length|filter|reduce|some|every)\\b`);
  return use.test(window);
}

function nthNewline(source: string, from: number, n: number): number {
  let idx = from;
  for (let i = 0; i < n; i++) {
    const next = source.indexOf("\n", idx + 1);
    if (next === -1) return source.length;
    idx = next;
  }
  return idx;
}

export function scanCappedReads(source: string, file = "<source>"): CappedReadFinding[] {
  const findings: CappedReadFinding[] = [];
  for (const m of source.matchAll(READ_SITE)) {
    const reader = m[1];
    const query = m[3];
    if (!query.includes("select=")) continue; // not a PostgREST list read
    if (SAFE_READERS.has(reader)) continue; // listAll / count are cap-safe
    if (/[?&]limit=/.test(query)) continue; // explicit bounded page

    const callIndex = m.index as number;
    const literalEnd = callIndex + m[0].length;
    if (!consumedAsAggregate(source, callIndex, literalEnd)) continue; // a [0] grab, not a count
    if (hasOptOut(source, callIndex)) continue; // documented as one-page-max

    findings.push({
      file,
      line: lineOf(source, callIndex),
      reader,
      query: query.length > 80 ? `${query.slice(0, 77)}...` : query,
    });
  }
  return findings;
}
