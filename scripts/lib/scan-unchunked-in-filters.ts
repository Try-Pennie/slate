// Static detector for the #2388 guard: a PostgREST `in` filter fed from a list that
// is UNBOUNDED by construction.
//
// The defect. `.in("col", ids)` puts every id in the QUERY STRING, so an oversized
// list is REFUSED at the transport rather than truncated. Measured against the real
// prod PostgREST on 2026-08-04, 350 uuids (13,028 bytes) is accepted and 400 (14,878)
// is refused, so the ceiling is roughly 266 ids at this repo's own 10,000 byte budget.
// A refusal on a scheduled lane is permanent rather than transient: the same rows are
// the same candidates the next night, so the lane never gets past them.
//
// Its SIBLING, `scan-batch-sizes.ts`, catches a list that IS split but by a literal
// row count. This catches the list that is not split at all, which is the case that
// had never been guarded and which #1321 explicitly chose not to write.
//
// A site is FLAGGED when the value handed to `.in(` mentions an identifier this file
// obtained from an unbounded read, meaning either:
//
//   - `const xs = await selectAllPages<T>(...)`, which pages until the rows run out,
//     so its length is bounded by the table rather than by anything in the code; or
//   - `const xs = await someReader(...)` where `someReader` is an exported function
//     whose own body reads through `selectAllPages`. That list is DERIVED by scanning
//     the tree rather than maintained by hand, so a reader added tomorrow is covered
//     by construction and cannot be exempt from the guard meant to catch it (L96).
//
// It is NOT flagged when:
//   - the value is a batch variable bound by `chunkIdsByUrlBudget` or `inIdChunks`,
//     which is what splitting looks like;
//   - the value mentions no unbounded identifier at all (a vocabulary constant, a
//     literal array of statuses, a roster bounded id list);
//   - an `// in-chunk-ok:` opt-out sits on, or in the `//` block directly above, the
//     `.in(` line, and CARRIES A REASON.
//
// WHAT IT CANNOT SEE, so a green run is never read as more than it is:
//
//   - a list that crosses a FUNCTION BOUNDARY as a callback parameter. The retention
//     lanes are exactly that shape: each lane reads 500 candidates and passes a
//     `destroy(ids)` callback to `destroyVerified`, so the `.in(` never names anything
//     this scanner could trace back. That case is covered by OWNING the split in
//     `destroyVerified` instead, which is stronger than a scan: a behaviour every call
//     site must opt into is enforced by nobody (L621).
//   - an array destructure of a `Promise.all` of paginated reads,
//     `const [a, b] = await Promise.all([selectAllPages(...), ...])`.
//   - a read bounded by `.limit(n)` with n above the ceiling. That is deliberately out
//     of scope rather than forgotten: every instance in this repo reaches its `.in(`
//     through the callback boundary above, so a rule here would look like coverage
//     while catching nothing.
//
// Deliberately a text scan, not a parser: lightweight and dependency-free, in the
// same family as scan-batch-sizes.ts and scan-swallowed-error-reads.ts.

export interface UnchunkedInFinding {
  file: string;
  line: number;
  /** The unbounded identifier the filter's value is built from. */
  source: string;
  snippet: string;
  /** True when an opt-out was present but carried no reason. */
  unreasoned: boolean;
}

export interface ScanInput {
  file: string;
  source: string;
}

const OPT_OUT = /\/\/\s*in-chunk-ok:\s*(.*)$/;
/** A batch handed out by one of the two splitters, in either spelling. */
const CHUNK_LOOP = /for\s*\(\s*const\s+(\w+)\s+of\s+chunkIdsByUrlBudget\s*\(/g;
/**
 * `inIdChunks(label, ids, (batch) => ...)`: the batch is the name bound by the
 * LAST argument, found by balancing parentheses rather than by a lazy character
 * class. The lazy version matched the first `(x)` it met, which for a call whose id
 * argument reads `items.map((it) => it.booking_id)` was `it`, and `it` then excused
 * every unrelated filter in the file that happened to use that name: a guard reading
 * clean over a real finding, which is the fault it exists to catch (L98).
 */
function chunkCallbackParams(code: string): Set<string> {
  const out = new Set<string>();
  const re = /inIdChunks\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let end = -1;
    for (let i = open; i < code.length; i += 1) {
      if (code[i] === "(") depth += 1;
      else if (code[i] === ")") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) continue;
    const args = code.slice(open + 1, end);
    // The final top level argument is the callback.
    let d = 0;
    let last = 0;
    for (let i = 0; i < args.length; i += 1) {
      const ch = args[i];
      if (ch === "(" || ch === "[" || ch === "{") d += 1;
      else if (ch === ")" || ch === "]" || ch === "}") d -= 1;
      else if (ch === "," && d === 0) last = i + 1;
    }
    const cb = args.slice(last);
    const param = /^\s*(?:async\s+)?\(?\s*([A-Za-z_$][\w$]*)/.exec(cb);
    if (param) out.add(param[1]);
  }
  return out;
}
/**
 * Any `const x = ...` binding, with whatever identifier its value starts from.
 *
 * Declarations are replayed IN FILE ORDER and each use resolves against the nearest
 * preceding one, because a name like `ids` or `rows` is re-bound in most of the
 * functions of a large module. Marking a name file-wide made `google/sync.ts` report
 * four findings for a paginated read declared 150 lines BELOW them.
 */
const DECLARATION =
  /\bconst\s+(\w+)(?:\s*:[^=]+)?\s*=\s*(await\s+)?\(?\[?(?:\.\.\.)?\s*(?:new\s+Set\s*\(\s*)?([A-Za-z_$][\w$]*)?/g;
/** An arrow function's parameter list, whose names shadow anything outside it. */
const ARROW_PARAMS = /\(([^()]*)\)\s*(?::[^=]*)?=>/g;
/** Words that appear inside a parameter list without being a binding. */
const RESERVED = new Set(["string", "number", "boolean", "unknown", "void", "null", "undefined", "Promise"]);

/** An exported function whose body reads every page: a source of unbounded lists. */
export function everyPageReaders(inputs: ScanInput[]): Set<string> {
  const names = new Set<string>();
  const decl = /export\s+(?:async\s+)?function\s+(\w+)\s*\(/g;
  for (const { source } of inputs) {
    const code = stripComments(source);
    let m: RegExpExecArray | null;
    while ((m = decl.exec(code)) !== null) {
      // The body runs to the next exported declaration, or to the end of the file.
      decl.lastIndex = m.index + m[0].length;
      const next = code.slice(decl.lastIndex).search(/\nexport\s/);
      const body = next === -1 ? code.slice(decl.lastIndex) : code.slice(decl.lastIndex, decl.lastIndex + next);
      if (body.includes("selectAllPages")) names.add(m[1]);
    }
  }
  return names;
}

/** Comments removed, so the guard is never satisfied by, or tripped by, prose (L103). */
function stripComments(source: string): string {
  return source
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
}

function collect(re: RegExp, code: string, group = 1): Set<string> {
  const out = new Set<string>();
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) out.add(m[group]);
  return out;
}

/**
 * The value expression of an `.in(col, VALUE)` starting at `open`, read by balancing
 * parentheses across lines, because a chained filter is routinely broken over several.
 */
function inFilterValue(code: string, open: number): string | null {
  let depth = 0;
  let end = -1;
  for (let i = open; i < code.length; i += 1) {
    const ch = code[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return null;
  const args = code.slice(open + 1, end);
  // Split on the FIRST top level comma: the column name is always the first argument.
  let d = 0;
  for (let i = 0; i < args.length; i += 1) {
    const ch = args[i];
    if (ch === "(" || ch === "[" || ch === "{") d += 1;
    else if (ch === ")" || ch === "]" || ch === "}") d -= 1;
    else if (ch === "," && d === 0) return args.slice(i + 1);
  }
  return null;
}

/** Whether an `// in-chunk-ok:` sits on, or in the `//` block above, this line. */
function optOut(lines: string[], index: number): { present: boolean; reason: string } {
  const here = OPT_OUT.exec(lines[index] ?? "");
  if (here) return { present: true, reason: here[1].trim() };
  for (let i = index - 1; i >= 0; i -= 1) {
    const line = (lines[i] ?? "").trim();
    if (line === "") continue;
    if (!line.startsWith("//")) break;
    const above = OPT_OUT.exec(line);
    if (above) return { present: true, reason: above[1].trim() };
  }
  return { present: false, reason: "" };
}

export function scanUnchunkedInFilters(inputs: ScanInput[]): UnchunkedInFinding[] {
  const readers = everyPageReaders(inputs);
  const findings: UnchunkedInFinding[] = [];

  for (const { file, source } of inputs) {
    const lines = source.split("\n");
    const code = stripComments(source);

    if (!code.includes(".in(")) continue;
    const batches = new Set([...collect(CHUNK_LOOP, code), ...chunkCallbackParams(code)]);

    // Declarations and `in` filters, interleaved by offset, so the state a filter is
    // judged against is the state at its own position in the file.
    type Event = { at: number } & (
      | { kind: "decl"; name: string; from: string | null; awaited: boolean }
      | { kind: "param"; names: string[] }
      | { kind: "use" }
    );
    const events: Event[] = [];

    DECLARATION.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = DECLARATION.exec(code)) !== null) {
      events.push({ at: m.index, kind: "decl", name: m[1], from: m[3] ?? null, awaited: m[2] !== undefined });
    }
    // An arrow function PARAMETER shadows an outer name, and the list it is handed
    // comes from outside this file, so nothing here can say whether it is bounded.
    // Without this, the monitor lane's `loadCachedBlocks: async (userIds, ...)` was
    // judged against an unrelated `userIds` declared 280 lines above it.
    ARROW_PARAMS.lastIndex = 0;
    while ((m = ARROW_PARAMS.exec(code)) !== null) {
      const names = (m[1].match(/[A-Za-z_$][\w$]*/g) ?? []).filter((n) => !RESERVED.has(n));
      if (names.length > 0) events.push({ at: m.index, kind: "param", names });
    }
    const inRe = /\.in\s*\(/g;
    while ((m = inRe.exec(code)) !== null) events.push({ at: m.index, kind: "use" });
    events.sort((a, b) => a.at - b.at);

    const unbounded = new Set<string>();
    for (const ev of events) {
      if (ev.kind === "param") {
        for (const n of ev.names) unbounded.delete(n);
        continue;
      }
      if (ev.kind === "decl") {
        const fromUnbounded =
          ev.from !== null &&
          ((ev.awaited && (ev.from === "selectAllPages" || readers.has(ev.from))) || unbounded.has(ev.from));
        // A re-binding always REPLACES what the name meant, so a bounded read of `ids`
        // in one function is not tainted by a paginated `ids` in another.
        if (fromUnbounded) unbounded.add(ev.name);
        else unbounded.delete(ev.name);
        continue;
      }
      if (unbounded.size === 0) continue;

      const open = code.indexOf("(", ev.at);
      const value = inFilterValue(code, open);
      if (value === null) continue;
      const names = new Set(value.match(/[A-Za-z_$][\w$]*/g) ?? []);
      // A batch variable anywhere in the value means this IS the split form.
      if ([...names].some((n) => batches.has(n))) continue;
      const sourceId = [...names].find((n) => unbounded.has(n));
      if (sourceId === undefined) continue;

      const line = code.slice(0, ev.at).split("\n").length - 1;
      const hatch = optOut(lines, line);
      if (hatch.present && hatch.reason.length > 0) continue;
      findings.push({
        file,
        line: line + 1,
        source: sourceId,
        snippet: (lines[line] ?? "").trim().slice(0, 120),
        unreasoned: hatch.present,
      });
    }
  }
  return findings;
}
