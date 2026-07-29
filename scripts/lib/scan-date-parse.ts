// Static detector for the #1171 guard: a raw `Date.parse` whose NaN would pass
// unnoticed. See scripts/test-date-parse-guard.ts for the why, the covered
// surface, its deliberate boundary, and the fixtures that prove this catches the
// bad pattern.
//
// The bug class (#1169): `Date.parse` returns NaN for anything it cannot read,
// EVERY comparison with NaN is false, and so the check lands on the healthy /
// permissive branch with no error raised anywhere: not stale, not expired, not
// due for retry, does not overlap. `parseStampMs` (src/lib/date/stamp.ts)
// returns a number or null instead, which forces the caller to decide what an
// unreadable stamp means.
//
// A `Date.parse(` occurrence is COMPLIANT when:
//   - the same line hands it straight to `Number.isFinite` / `Number.isNaN` /
//     `isNaN`, so the NaN case is explicitly judged; or
//   - a `// parse-ok:` opt-out sits on the line, or in the contiguous block of
//     `//` comment lines directly above it, saying why NaN is impossible or safe.
// (`parseStampMs` needs no rule of its own: a call site using it contains no
// `Date.parse` at all. The helper's own internal parse is guarded by its
// `Number.isFinite` and so is compliant by the first rule.)
//
// Like its sibling scanners (scan-src-capped-reads.ts,
// scan-swallowed-error-reads.ts) this is a deliberate text scan, not a parser:
// lightweight, dependency free, with an escape hatch that keeps it from false
// flagging the parses that genuinely cannot fail.
//
// SCOPE NOTE: it flags EVERY unguarded occurrence in the covered surface, not
// only those it can see feeding a comparison. Tracking "does this value reach a
// comparison" across statements is exactly the kind of analysis a text scan gets
// quietly wrong, and a missed site here is the bug shipping again. Over-flagging
// costs one comment; under-flagging costs an outage that looks healthy.

export interface RawDateParseFinding {
  file: string;
  line: number;
  /** The offending line, whitespace collapsed and truncated for readability. */
  snippet: string;
}

const NAN_CHECKS = ["Number.isFinite(", "Number.isNaN(", "isNaN("];

/**
 * True if a `// parse-ok` opt-out is attached: a comment on the line itself, or
 * anywhere in the contiguous block of `//` comment lines immediately above it
 * (so a multi-line justification counts). Mirrors the sibling scanners' hatch.
 */
function hasOptOut(lines: string[], index: number): boolean {
  if (/\/\/\s*parse-ok/i.test(lines[index])) return true;
  for (let i = index - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed.startsWith("//")) break;
    if (/\/\/\s*parse-ok/i.test(trimmed)) return true;
  }
  return false;
}

/**
 * True if every `Date.parse(` on the line is an argument to an explicit NaN
 * check. Checked per line so a line that guards one parse but leaves another
 * raw (`Number.isFinite(Date.parse(a)) && Date.parse(b) > x`) is still flagged.
 */
function everyParseIsChecked(line: string): boolean {
  let searchFrom = 0;
  for (;;) {
    const at = line.indexOf("Date.parse(", searchFrom);
    if (at === -1) return true;
    const before = line.slice(0, at);
    if (!NAN_CHECKS.some((c) => before.endsWith(c))) return false;
    searchFrom = at + "Date.parse(".length;
  }
}

export function scanRawDateParse(source: string, file = "<source>"): RawDateParseFinding[] {
  const findings: RawDateParseFinding[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes("Date.parse(")) continue;
    if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue; // prose, not code
    if (everyParseIsChecked(line)) continue;
    if (hasOptOut(lines, i)) continue;

    const snippet = line.replace(/\s+/g, " ").trim();
    findings.push({
      file,
      line: i + 1,
      snippet: snippet.length > 100 ? `${snippet.slice(0, 97)}...` : snippet,
    });
  }
  return findings;
}
