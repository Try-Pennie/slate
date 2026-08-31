// Static detector for the #315 guard: a swallowed-error Supabase list read in
// the availability / booking / google-sync / routing paths (the scanned dirs
// live in scripts/test-swallowed-error-reads.ts; #865 widened them to sync +
// routing). See that file for the why and the fixtures that prove this actually
// catches the bad pattern.
//
// The bug class (#277): an availability-critical read destructured
// `const { data } = await db.from("t").select(...)` and IGNORED `error`. When
// the query failed (a missing column on a half-applied migration), `data` came
// back null, the pool collapsed to empty, and the booker silently showed NO
// availability: a broken deploy that looked like a quiet day. #277 routed the
// critical reads through `unwrap` (src/lib/db/result.ts) so a real query error
// throws instead of degrading. Nothing stopped a NEW `const { data } = await`
// read that ignores `error` from creeping back into these paths and eroding the
// invariant. This guard closes that.
//
// A "read site" is an object destructure of an awaited Supabase SELECT:
//   const { data } = await db.from("t").select(...)...;
//   const { data: alias } = await supabaseAdmin().from("t").select(...)...;
//   let q = db.from("t").select(...); ...; const { data } = await q.maybeSingle();
// It is FLAGGED when the destructure binds `data` (the result is consumed) but
// does NOT bind `error`, and no `// error-ok:` opt-out is attached.
//
// It is NOT flagged when the read:
//   - also binds `error` (`const { data, error } = ...`), so the caller can
//     consult it;
//   - goes through `unwrap(await ...)` or a paginating helper like
//     `selectAllPages(...)` (neither produces a `const { data }` destructure at
//     all, so they never match);
//   - is a write, not a list read: a `.insert`/`.update`/`.delete`/`.upsert`
//     reached before the `.select(` (an "update ... returning" shape). A failed
//     write is a different concern than the availability read this guard exists
//     for;
//   - carries a `// error-ok:` opt-out on, or in the `//` block directly above,
//     the destructure line (the escape hatch, below).
//
// A SECOND read site (#1629): the RESULT-OBJECT member read.
//   const [usersRes, bucketsRes] = await Promise.all([
//     db.from("users").select("*"),
//     db.from("buckets").select("*"),
//   ]);
//   const users = (usersRes.data ?? []) as User[];
// Here the result object is bound whole and `.data` is read off it later, so no
// `const { data } = await` ever appears and the destructure scan above cannot
// see it. It is FLAGGED when the bound name's `.data` is read somewhere in the
// file, its `.error` is read NOWHERE, the element it was bound to is a Supabase
// select, and no `// error-ok:` opt-out is attached (to the binding, or to the
// `.data` read).
//
// This shape is why widening the scanned PATHS alone would have fixed nothing
// for #1629: `src/lib/routing` has been in scope since #865, and
// `staffing-depth-load.ts` sat inside it reading four tables as
// `(<name>Res.data ?? [])` the whole time, with the guard reporting clean over
// it. A guard blind to the shape is a guard, not coverage (L98).
//
// SCOPE (deliberate, honest boundary): the two shapes above are what this
// covers. It intentionally does NOT chase two rarer ones, so it never claims
// coverage it does not have (a false-confidence check is Slate's most repeated
// defect class):
//   - an ARRAY destructure of OBJECT patterns, `const [{ data: a }, { data: b }]
//     = await Promise.all([...])`; and
//   - an inline member read, `(await db.from(...).select(...)).data`, including
//     the loop form `for (const r of await Promise.all(qs)) use(r.data)`, where
//     the result object is never given a name to track.
// Both are discouraged by review; the two shapes above are the ones that keep
// reappearing and are what this guards.
//
// THE ESCAPE HATCH (`// error-ok:`). A read that DELIBERATELY tolerates a null /
// empty result on a query error opts out with a one-line reason on, or in the
// `//` block directly above, the destructure:
//
//   // error-ok: best-effort worklist; a read error just skips this tick and retries
//   const { data } = await db.from("pending_event_deletions").select("*").limit(n);
//
// Use it only when a swallowed error genuinely degrades to a SAFE path (a retry
// next tick, a re-route, a caller null / empty branch), and say why. A read whose
// swallowed error would silently show no availability must use `unwrap` instead.
//
// Like the sibling scan-src-capped-reads.ts this is a deliberate text scan, not a
// full parser: lightweight, dependency free, with an escape hatch that keeps it
// from false flagging the legitimately null tolerant reads.

export interface SwallowedReadFinding {
  file: string;
  line: number;
  /** The destructure bindings, e.g. `data` or `data: booking`. */
  binding: string;
  /** The read snippet (whitespace collapsed, truncated for readability). */
  snippet: string;
  /**
   * Which read site it is, so the failure message can name the right remedy:
   * `destructure` for `const { data } = await ...`, `result-object` for a whole
   * result bound to a name and read later as `<name>.data`.
   */
  shape: "destructure" | "result-object";
}

// `const { ... } = await` (also let / var). `[^{}]*` keeps it to a flat object
// destructure; `const [{ ... }]` (array) starts with `[` and never matches, which
// is the documented scope boundary above.
const DESTRUCTURE = /(?:const|let|var)\s*\{([^{}]*)\}\s*=\s*await\b/g;
const MUTATORS = [".insert(", ".update(", ".delete(", ".upsert("];

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === "\n") line++;
  }
  return line;
}

/** The destructured key names (left of any `:` alias), lower-cased and trimmed. */
function bindingKeys(bindings: string): Set<string> {
  const keys = new Set<string>();
  for (const part of bindings.split(",")) {
    const key = part.split(":")[0].trim();
    if (key) keys.add(key);
  }
  return keys;
}

/**
 * True if a `// error-ok` opt-out is attached to the read: a trailing comment on
 * the destructure line, or anywhere in the contiguous block of `//` comment lines
 * immediately above it (so a multi-line justification counts). Mirrors the
 * sibling scan-src-capped-reads.ts.
 */
function hasOptOut(source: string, destructureIndex: number): boolean {
  const lines = source.slice(0, destructureIndex).split("\n");
  if (/\/\/\s*error-ok/i.test(lines[lines.length - 1] ?? "")) return true;
  for (let i = lines.length - 2; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed.startsWith("//")) break;
    if (/\/\/\s*error-ok/i.test(trimmed)) return true;
  }
  return false;
}

/**
 * The text to analyze for the `.from(`/`.select(`/mutator ordering: the awaited
 * expression (from just after `await` to the statement's `;`). When that
 * expression is a bare builder variable with no `.from(` of its own
 * (`await q.limit(1).maybeSingle()`, or the bare `await q`), the variable's
 * nearest preceding `const/let/var q = ...` definition is prepended, so a
 * `.from("t").select(...)` (or a `.update(...)` that makes it a write) declared
 * on an earlier line still counts. A sibling query on a neighbouring line is
 * never pulled in.
 *
 * The bare `await q` form matters (#1165): the header's pending-time-off count
 * is written that way, so a lead pattern that required a trailing `.` would have
 * silently skipped it and the guard would have reported clean over a live
 * instance of the very bug it exists to catch.
 */
function analysisText(source: string, exprStart: number): string {
  const semi = source.indexOf(";", exprStart);
  const expr = source.slice(exprStart, semi === -1 ? Math.min(exprStart + 600, source.length) : semi);
  if (expr.includes(".from(")) return expr;

  const lead = /^\s*([A-Za-z_$][\w$]*)\s*(?:\.|$)/.exec(expr);
  if (!lead) return expr;
  const varName = lead[1];
  const defRe = new RegExp(`(?:const|let|var)\\s+${varName}\\s*=`, "g");
  let defIndex = -1;
  for (const dm of source.slice(0, exprStart).matchAll(defRe)) defIndex = dm.index as number;
  if (defIndex === -1) return expr;
  const defEnd = source.indexOf(";", defIndex);
  const def = source.slice(defIndex, defEnd === -1 ? exprStart : defEnd);
  return `${def};${expr}`;
}

/** True if the chain is a Supabase list read (a `.select(` reached before any mutator). */
function isSelectRead(text: string): boolean {
  if (!text.includes(".from(")) return false;
  const sel = text.indexOf(".select(");
  if (sel === -1) return false;
  for (const m of MUTATORS) {
    const idx = text.indexOf(m);
    if (idx !== -1 && idx < sel) return false; // a write reached first
  }
  return true;
}

/**
 * A same-length copy of `source` with the CONTENT of comments and string / template
 * literals blanked to spaces. Structural scanning (bracket matching, top-level
 * comma splitting) runs over this so a comma inside a `//` comment or a string can
 * never be read as a separator.
 *
 * Same length, so every index into the mask is an index into the original: the
 * caller slices the ORIGINAL for the text it reports.
 *
 * This matters concretely. The admin page's `Promise.all` opens with a two-line
 * `//` comment containing two commas, which without the mask split the first
 * element into three and shifted every name onto the wrong query for the rest of
 * the array (#1629). A guard that names the wrong read is worse than one that
 * names none, because the reader goes and looks at code that is fine.
 */
function maskLiterals(source: string): string {
  const out = source.split("");
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") out[i++] = " ";
      continue;
    }
    if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      while (i < stop) {
        if (source[i] !== "\n") out[i] = " ";
        i++;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === "\\") {
          out[i] = " ";
          i++;
        }
        if (i < source.length && source[i] !== "\n") out[i] = " ";
        i++;
      }
      i++;
      continue;
    }
    i++;
  }
  return out.join("");
}

/**
 * The offsets of the TOP-LEVEL commas' separated spans within `masked`, ignoring
 * commas nested inside brackets (comments and strings are already blanked). Used
 * to line the elements of a `Promise.all([...])` up with the names the array
 * destructure binds them to.
 */
function splitTopLevel(masked: string): { start: number; end: number }[] {
  const parts: { start: number; end: number }[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      parts.push({ start, end: i });
      start = i + 1;
    }
  }
  parts.push({ start, end: masked.length });
  return parts;
}

/** The index of the bracket that closes the one opened at `openIndex` (-1 if none). */
function matchBracket(masked: string, openIndex: number): number {
  const open = masked[openIndex];
  const close = open === "[" ? "]" : open === "(" ? ")" : "}";
  let depth = 0;
  for (let i = openIndex; i < masked.length; i++) {
    const c = masked[i];
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** `const [a, b, c] = await Promise.all([`: the names, up to the array's `[`. */
const ARRAY_FROM_PROMISE_ALL =
  /(?:const|let|var)\s*\[([^\][]*)\]\s*=\s*await\s+Promise\.all\s*\(\s*\[/g;
/** `const usersRes = await db.from("users")...`: a whole result bound to a name. */
const NAMED_AWAIT = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\b/g;

/**
 * A `Promise.all` element's own chain text. An element that is a BARE BUILDER NAME
 * (`bucketsQuery`) carries no `.from(` of its own, so its nearest preceding
 * `const/let/var bucketsQuery = ...` definition stands in for it. Scoped to the
 * element, never to the statement, because the statement holds every sibling
 * query and reading those would attribute one name's chain to another.
 *
 * loadTierDepths writes three of its four reads that way (`let bucketsQuery = ...`
 * then `.eq("org_id", orgId)` conditionally), so without this the guard reaches
 * one of the four reads named in #1629 and reports the other three clean.
 */
function resolveElementChain(masked: string, elementText: string, beforeIndex: number): string {
  if (elementText.includes(".from(")) return elementText;
  const bare = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(elementText);
  if (!bare) return elementText;
  const defRe = new RegExp(`(?:const|let|var)\\s+${bare[1]}\\s*=`, "g");
  let defIndex = -1;
  for (const dm of masked.slice(0, beforeIndex).matchAll(defRe)) defIndex = dm.index as number;
  if (defIndex === -1) return elementText;
  const defEnd = masked.indexOf(";", defIndex);
  return masked.slice(defIndex, defEnd === -1 ? beforeIndex : defEnd);
}

/** Every index in `source` where `<name>.<member>` is read. */
function memberReadIndexes(source: string, name: string, member: string): number[] {
  const re = new RegExp(`\\b${name}\\s*\\.\\s*${member}\\b`, "g");
  return [...source.matchAll(re)].map((m) => m.index as number);
}

/**
 * The RESULT-OBJECT member read (#1629): a whole Supabase result bound to a name
 * and read later as `<name>.data`, with `<name>.error` read nowhere.
 *
 * The opt-out may sit above the BINDING or above any `<name>.data` read, because
 * the two are routinely tens of lines apart and the reason belongs wherever the
 * reader of the empty value is.
 */
function scanResultObjectReads(source: string, file: string): SwallowedReadFinding[] {
  const findings: SwallowedReadFinding[] = [];
  const masked = maskLiterals(source);
  const seen = new Set<string>();

  const consider = (
    name: string,
    chainText: string,
    bindingIndex: number,
    reportSpan?: { start: number; end: number },
  ) => {
    if (!name || seen.has(name)) return;
    if (!isSelectRead(chainText)) return; // a write, or not a supabase select
    const dataReads = memberReadIndexes(masked, name, "data");
    if (dataReads.length === 0) return; // the result is never consumed as `.data`
    if (memberReadIndexes(masked, name, "error").length > 0) return; // error is consulted
    if (hasOptOut(source, bindingIndex)) return; // documented null-tolerant
    if (dataReads.some((i) => hasOptOut(source, i))) return;
    seen.add(name);
    // Reported from the ORIGINAL text, not the mask, so the snippet in the failure
    // message still names the table the read is on. Leading `//` lines are dropped
    // first: a two-line comment above the query eats the whole 100-character
    // budget, and the message then quotes prose instead of the read.
    const shown = (reportSpan ? source.slice(reportSpan.start, reportSpan.end) : chainText)
      .split("\n")
      .filter((l) => !/^\s*\/\//.test(l))
      .join("\n");
    const snippet = `${name} = ${shown}`.replace(/\s+/g, " ").trim();
    findings.push({
      file,
      line: lineOf(source, bindingIndex),
      binding: `${name}.data`,
      snippet: snippet.length > 100 ? `${snippet.slice(0, 97)}...` : snippet,
      shape: "result-object",
    });
  };

  // `const [a, b] = await Promise.all([chainA, chainB])`: element i belongs to name i.
  for (const m of masked.matchAll(ARRAY_FROM_PROMISE_ALL)) {
    const bindingIndex = m.index as number;
    const arrayOpen = bindingIndex + m[0].length - 1;
    const arrayClose = matchBracket(masked, arrayOpen);
    if (arrayClose === -1) continue;
    const base = arrayOpen + 1;
    const spans = splitTopLevel(masked.slice(base, arrayClose));
    const names = m[1].split(",").map((n) => n.trim());
    for (let i = 0; i < names.length; i++) {
      const span = spans[i];
      if (!span) continue;
      consider(
        names[i],
        resolveElementChain(masked, masked.slice(base + span.start, base + span.end), bindingIndex),
        bindingIndex,
        { start: base + span.start, end: base + span.end },
      );
    }
  }

  // `const usersRes = await db.from("users").select(...)`
  for (const m of masked.matchAll(NAMED_AWAIT)) {
    const bindingIndex = m.index as number;
    consider(m[1], analysisText(masked, bindingIndex + m[0].length), bindingIndex);
  }

  return findings;
}

export function scanSwallowedErrorReads(source: string, file = "<source>"): SwallowedReadFinding[] {
  const findings: SwallowedReadFinding[] = [];
  for (const m of source.matchAll(DESTRUCTURE)) {
    const keys = bindingKeys(m[1]);
    if (!keys.has("data")) continue; // result not consumed as `data`
    if (keys.has("error")) continue; // error is captured for the caller

    const destructureIndex = m.index as number;
    const exprStart = destructureIndex + m[0].length;
    const text = analysisText(source, exprStart);
    if (!isSelectRead(text)) continue; // a write, or not a supabase select
    if (hasOptOut(source, destructureIndex)) continue; // documented null-tolerant

    const snippet = text.replace(/\s+/g, " ").trim();
    findings.push({
      file,
      line: lineOf(source, destructureIndex),
      binding: m[1].trim(),
      snippet: snippet.length > 100 ? `${snippet.slice(0, 97)}...` : snippet,
      shape: "destructure",
    });
  }
  findings.push(...scanResultObjectReads(source, file));
  return findings.sort((a, b) => a.line - b.line);
}

/**
 * The count-shaped twin of the scan above (#1165), for the guard in
 * scripts/test-swallowed-count-results.ts (which carries the full why).
 *
 * A PostgREST result asked for `{ count: "exact" }` reports a FAILED query as
 * `count: null`, and the `count ?? 0` at the call site launders that into a
 * healthy-looking "0 rows affected": a delete that never ran reads exactly like
 * an agent with nothing to clean. This flags an awaited Supabase chain
 * destructured for `count` without also binding `error`.
 *
 * TWO DELIBERATE DIFFERENCES from the read scan:
 *   - a WRITE is flagged too. `delete({ count: "exact" })` is the headline case,
 *     so the "a mutator reached first means it's a write, skip it" rule that
 *     applies to `data` reads would skip precisely what this exists to catch;
 *   - `.select(` is not required, for the same reason.
 * A Supabase chain is identified by `.from(` alone, so a non-Supabase
 * `const { count } = await api()` never matches.
 *
 * Shares the destructure regex, opt-out and builder-resolution helpers above, so
 * both guards agree on what a read site is and on the one `// error-ok:` escape
 * hatch.
 */
export function scanSwallowedCountResults(
  source: string,
  file = "<source>",
): SwallowedReadFinding[] {
  const findings: SwallowedReadFinding[] = [];
  for (const m of source.matchAll(DESTRUCTURE)) {
    const keys = bindingKeys(m[1]);
    if (!keys.has("count")) continue; // result not consumed as `count`
    if (keys.has("error")) continue; // error is captured for the caller

    const destructureIndex = m.index as number;
    const exprStart = destructureIndex + m[0].length;
    const text = analysisText(source, exprStart);
    if (!text.includes(".from(")) continue; // not a supabase chain
    if (hasOptOut(source, destructureIndex)) continue; // documented zero-tolerant

    const snippet = text.replace(/\s+/g, " ").trim();
    findings.push({
      file,
      line: lineOf(source, destructureIndex),
      binding: m[1].trim(),
      snippet: snippet.length > 100 ? `${snippet.slice(0, 97)}...` : snippet,
      shape: "destructure",
    });
  }
  return findings;
}
