// Static detector for the #315 guard: a swallowed-error Supabase list read in
// the availability / booking paths. See scripts/test-swallowed-error-reads.ts
// for the why and the fixtures that prove this actually catches the bad pattern.
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
// SCOPE (deliberate, honest boundary): this scanner covers the exact shape #277
// warned about and the issue quotes, an OBJECT destructure of an awaited select
// (`const { ... } = await ...`). It intentionally does NOT chase two rarer
// shapes, so it never claims coverage it does not have (a false-confidence check
// is Slate's most repeated defect class):
//   - an ARRAY destructure element, `const [{ data: a }, { data: b }] = await
//     Promise.all([...])`; and
//   - an inline member read, `(await db.from(...).select(...)).data`.
// Both are discouraged by review; the `const { data } = await` form is the one
// that keeps reappearing and is what this guards.
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
 * (`await q.limit(1).maybeSingle()`), the variable's nearest preceding
 * `const/let/var q = ...` definition is prepended, so a `.from("t").select(...)`
 * (or a `.update(...)` that makes it a write) declared on an earlier line still
 * counts. A sibling query on a neighbouring line is never pulled in.
 */
function analysisText(source: string, exprStart: number): string {
  const semi = source.indexOf(";", exprStart);
  const expr = source.slice(exprStart, semi === -1 ? Math.min(exprStart + 600, source.length) : semi);
  if (expr.includes(".from(")) return expr;

  const lead = /^\s*([A-Za-z_$][\w$]*)\s*\./.exec(expr);
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
    });
  }
  return findings;
}
