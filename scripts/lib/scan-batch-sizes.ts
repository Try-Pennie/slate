// Static detector for the #1269 guard: a batched PostgREST `in(...)` filter whose
// chunk size is a bare literal rather than measured from the ids themselves. See
// scripts/test-batch-sizes.ts for the why and the fixtures proving it catches the
// bad pattern.
//
// The defect. `.in("id", ids)` puts every id in the QUERY STRING, so an oversized
// batch is REFUSED at the transport rather than merely slow. A COUNT only bounds
// the URL while every id is the same length, so a count carried over from a call
// site with shorter keys ships broken: uuids are 36 characters, while
// `busy_blocks.gcal_event_id` averaged 43 and reached 181 in production. Three
// instances shipped or nearly shipped in one day (#1259 PR#1251's 500-row stride,
// #1267's unchunked delete, #1268's 500-id delete).
//
// A site is FLAGGED when a chunking stride is a bare NUMERIC LITERAL and an
// `.in(` filter is fed from the slice it produces. It is NOT flagged when:
//   - the chunks come from `chunkIdsByUrlBudget`, which measures the ids it is
//     actually given, so no per-key-type calibration exists to get wrong;
//   - the stride is a named constant (an identifier), which at least has one
//     definition to reason about rather than a number copied inline. The named
//     constant is still only as good as its own justification, which is why
//     `SAFE_UUID_BATCH_FOR_MEASUREMENT` documents that it is not a batching knob;
//   - the loop feeds no `.in(` at all (a concurrency wave, a Google items cap
//     like FREEBUSY_MAX_ITEMS, a POST body chunk), because none of those ride in
//     a URL;
//   - a `// batch-ok:` opt-out sits on, or in the `//` block directly above, the
//     stride.
//
// Deliberately a text scan, not a parser: lightweight and dependency-free, in the
// same family as scan-src-capped-reads.ts and scan-swallowed-error-reads.ts.

export interface BatchSizeFinding {
  file: string;
  line: number;
  /** The literal stride the loop advances by. */
  stride: number;
  snippet: string;
}

/** `for (let i = 0; i < xs.length; i += 200)` and the `i = i + 200` spelling. */
const STRIDE_RE = /\bfor\s*\([^)]*;\s*\w+\s*(?:\+=|=\s*\w+\s*\+)\s*(\d+)\s*\)/;
/** `xs.slice(i, i + 200)` as a stride in its own right, for a loop written any
 *  other way (a while, a recursive chunker, a map over indices). */
const SLICE_RE = /\.slice\(\s*\w+\s*,\s*\w+\s*\+\s*(\d+)\s*\)/;
/** An `.in("col", ...)` filter: the thing whose size the URL actually bounds. */
const IN_FILTER_RE = /\.in\(\s*["'`]/;
const OPT_OUT = /\/\/\s*batch-ok:/;

/** How far below a stride to look for the `.in(` it feeds. A chunked read or
 *  write is a handful of lines; beyond that the two are unrelated. */
const LOOKAHEAD_LINES = 14;

function optedOut(lines: string[], index: number): boolean {
  if (OPT_OUT.test(lines[index] ?? "")) return true;
  // Walk up through a contiguous `//` comment block, the same shape the sibling
  // guards accept, so a multi-line justification counts.
  for (let i = index - 1; i >= 0; i -= 1) {
    const line = (lines[i] ?? "").trim();
    if (line === "") continue;
    if (!line.startsWith("//")) return false;
    if (OPT_OUT.test(line)) return true;
  }
  return false;
}

export function scanBatchSizes(source: string, file = "<source>"): BatchSizeFinding[] {
  const lines = source.split("\n");

  // Every line carrying a literal stride. ONE chunked read routinely produces two
  // (the loop header and the `slice(i, i + N)` inside it), so these are grouped
  // below rather than reported individually: two findings for one construct would
  // make the opt-out cover only the first of them, so an annotated site would
  // still fail, and a reader would be told twice about one decision.
  const candidates: { index: number; stride: number }[] = [];
  lines.forEach((line, i) => {
    // Comments stripped before matching, so the guard is never satisfied by, or
    // tripped by, prose ABOUT a stride (L103).
    const code = line.replace(/\/\/.*$/, "");
    const stride = STRIDE_RE.exec(code)?.[1] ?? SLICE_RE.exec(code)?.[1];
    if (stride !== undefined) candidates.push({ index: i, stride: Number(stride) });
  });

  const findings: BatchSizeFinding[] = [];
  let group: { index: number; stride: number }[] = [];

  const flush = () => {
    if (group.length === 0) return;
    const first = group[0];
    // Does this construct actually feed a URL filter? A concurrency wave, a
    // Google items cap or a POST body chunk has no URL to overflow.
    const window = lines
      .slice(first.index, group[group.length - 1].index + LOOKAHEAD_LINES)
      .map((l) => l.replace(/\/\/.*$/, ""))
      .join("\n");
    // The opt-out may sit above the construct or on any of its stride lines, so
    // an author annotating the loop header covers the slice inside it.
    const excused = group.some((c) => optedOut(lines, c.index));
    if (IN_FILTER_RE.test(window) && !excused) {
      findings.push({
        file,
        line: first.index + 1,
        stride: first.stride,
        snippet: (lines[first.index] ?? "").trim().slice(0, 120),
      });
    }
    group = [];
  };

  for (const c of candidates) {
    const previous = group[group.length - 1];
    if (previous && c.index - previous.index > LOOKAHEAD_LINES) flush();
    group.push(c);
  }
  flush();

  return findings;
}
