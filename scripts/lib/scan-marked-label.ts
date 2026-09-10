// A mark beside a word, aligned by hand (#2112).
//
// The other half of L613 is the guard, and this is it. `MarkedLabel` converts the
// six sites that existed; what a scan answers is the site written NEXT month: a row
// laid out with `items-center`, a small round mark, and a word beside it, each one
// a pixel out for its own reason and reported as its own bug from whichever screen
// somebody happened to be looking at.
//
// It looks for the STRUCTURE rather than for the nudge, deliberately. A scan for
// `top-[-1px]` would find only the rows somebody had already noticed was wrong,
// which is the population that needs no guard: the ones that ship misaligned carry
// no offset at all.
//
// PURE, so `scripts/test-marked-label-coverage.ts` drives it over fixtures as well
// as over the real tree.

/**
 * A MARK: a small shape whose whole job is to be a shape.
 *
 * Sized in the `h-1.5` to `h-3` range the real ones use, and it must carry BOTH a
 * height and a width (or `size-`), because that is what separates a mark from the
 * two round things that are not one. An avatar or a spinner is also round and also
 * sits beside a word, and neither has this problem: a bigger element reads as an
 * object beside the line rather than as part of it. And a PROGRESS BAR is `h-2
 * rounded-full` with no width of its own, since its width is the measurement; the
 * booking outcomes page has one per row and the first version of this reported all
 * of them.
 */
const SIZE = "(?:h-(?:1|1\\.5|2|2\\.5|3)\\b[^\"'`]*\\bw-(?:1|1\\.5|2|2\\.5|3)|size-(?:1|1\\.5|2|2\\.5|3))";
const MARK = new RegExp(`\\b${SIZE}\\b[^"'\`]*\\brounded-full\\b|\\brounded-full\\b[^"'\`]*\\b${SIZE}\\b`);

/**
 * A mark taken OUT of the line's flow is not in the row at all, so nothing centres
 * it and there is nothing to line up: the account menu's avatar badge and the
 * calendar's today marker are both positioned against an edge of the thing they
 * belong to. Reporting them would send somebody to convert two rows that are
 * correct, which is how a guard stops being read (L36).
 */
const OUT_OF_FLOW = /\babsolute\b|\bfixed\b/;

/** A row that centres its children on each other, which is where the fault lives. */
const ROW = /\bitems-center\b/;

/** Text between the tags: the WORD the mark is beside. A mark with no label is an
 *  ornament and has nothing to line up with. */
const LABEL = />\s*(?:\{[^}]*\}|[A-Za-z0-9])/;

/**
 * The one line opt out, which must carry a reason.
 *
 * In ANY comment form, because the place it has to be written is between JSX
 * elements, where `//` is not a comment at all.
 *
 * The reason must start with a WORD, not merely with a non-space character, which
 * is what tells `mark-ok: an oval` from a bare `{/* mark-ok: *\/}` whose only
 * "reason" is the comment's own terminator. A marker with no reason beside
 * neighbours that each carry one is evidence nobody reasoned about it (L233), so an
 * exemption that reads as deliberate has to actually say something.
 */
const OPT_OUT = /mark-ok:[ \t]*[A-Za-z0-9]/;

/** Files that own this alignment rather than repeat it, each for a stated reason. */
const OWNERS: Readonly<Record<string, string>> = {
  "src/components/ui/MarkedLabel.tsx": "is the shared component",
  // A pill has an oval to centre the pair inside, so it moves the LABEL down
  // rather than the mark up. Same alignment, one more thing to satisfy.
  "src/components/ui/Pill.tsx": "centres the pair in an oval, so it moves the label",
};

export interface HandRolledMark {
  file: string;
  line: number;
}

/**
 * Every row in this source that puts a mark beside a word without `MarkedLabel`.
 *
 * A row is compliant when it is a `MarkedLabel`, when its mark is being handed to
 * one as the `mark` prop, when the file owns the alignment, or when it carries the
 * `mark-ok:` opt out on the row's own line or in the comment block above it.
 */
export function scanMarkedLabel(file: string, source: string): HandRolledMark[] {
  if (file.replaceAll("\\", "/") in OWNERS) return [];
  const lines = source.split("\n");
  const out: HandRolledMark[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!MARK.test(lines[i]!)) continue;
    if (OUT_OF_FLOW.test(lines[i]!)) continue;
    const open = tagOpening(lines, i);
    // Already on its way to the shared component: `mark={<span ... />}`.
    if (/\bmark=\{/.test(lines.slice(Math.max(0, open - 2), i + 1).join("\n"))) continue;

    // The row this mark sits in. Walked UP rather than matched on one line,
    // because the container's `items-center` is routinely several lines above a
    // mark whose own tag spans four (L518).
    const row = enclosingRow(lines, open);
    if (row === null) continue;
    if (/<MarkedLabel\b/.test(lines[row]!)) continue;
    if (!LABEL.test(lines.slice(row, Math.min(lines.length, row + ROW_SPAN)).join("\n"))) continue;
    if (optedOut(lines, row) || optedOut(lines, i)) continue;
    out.push({ file, line: row + 1 });
  }
  return out;
}

/** How far below a row's opening tag its label may sit and still be its label. */
const ROW_SPAN = 24;
/** How far above a mark its row's opening tag may sit. */
const ROW_REACH = 12;

/** The line the element holding line `at`'s classes opens on. */
function tagOpening(lines: string[], at: number): number {
  for (let k = at; k >= 0 && at - k < 8; k--) if (/<[A-Za-z]/.test(lines[k]!)) return k;
  return at;
}

/** The nearest opening tag above `at` that centres its children, or null. */
function enclosingRow(lines: string[], at: number): number | null {
  for (let k = at; k >= 0 && at - k < ROW_REACH; k--) {
    if (!ROW.test(lines[k]!)) continue;
    const open = tagOpening(lines, k);
    // Its own class list, not the mark's: a mark that centres its own contents
    // (an icon inside it) is not the row.
    if (open === tagOpening(lines, at) && open !== at) continue;
    return open;
  }
  return null;
}

/**
 * The opt out on the line itself, or in the comment block directly above it.
 *
 * Read WHOLE rather than line by line, for the reason `scan-unsaved-guard` records:
 * the reason is a sentence, a sentence wraps, and the marker is on the block's
 * first line while the line above the code is its last.
 */
function optedOut(lines: string[], at: number): boolean {
  if (OPT_OUT.test(lines[at]!)) return true;
  let j = at - 1;
  while (j >= 0 && lines[j]!.trim() === "") j--;
  if (j < 0) return false;
  const line = lines[j]!.trim();

  if (line.startsWith("//")) {
    const run: string[] = [];
    for (let k = j; k >= 0 && lines[k]!.trim().startsWith("//"); k--) run.push(lines[k]!);
    return OPT_OUT.test(run.join("\n"));
  }

  if (!line.endsWith("*/") && !line.endsWith("*/}")) return false;
  const block: string[] = [];
  for (let k = j; k >= 0; k--) {
    block.push(lines[k]!);
    if (lines[k]!.includes("/*")) return OPT_OUT.test(block.join("\n"));
  }
  return false;
}
