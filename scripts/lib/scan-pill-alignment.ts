/**
 * Scan for a Pill starting a table cell without `alignToColumn` (#1821).
 *
 * A `Pill` sits its label 9px in from its own edge (a 1px transparent border plus
 * 8px of padding), so a pill starting a `<td>` put its word 9px right of the
 * column header's word: the header lined up with the pill's rounded edge rather
 * than with its label.
 *
 * The tempting fix was a negative margin on the one cell somebody looked at,
 * which leaves every other column misaligned by the same nine pixels and makes
 * each future call site responsible for a magic number belonging to the pill's own
 * geometry (L550). So the cancellation lives on the component and this is what
 * keeps the call sites using it, and keeps the workaround from coming back one
 * cell at a time.
 *
 * The rule is per CELL, not per pill: the FIRST pill in a cell is the one at the
 * column's edge and must align, and any pill beside it must NOT, because pulling
 * the second would eat the gap between the two (the time off page puts two
 * together).
 */

export interface PillAlignmentSite {
  file: string;
  line: number;
  why: string;
}

const OPT_OUT = /\/\/\s*pill-align-ok:\s*\S/;

/** Every `<td ...>` ... `</td>` span, as [start, end) offsets. */
function cellRanges(text: string): [number, number][] {
  const out: [number, number][] = [];
  const open = /<td[\s>]/g;
  let m: RegExpExecArray | null;
  while ((m = open.exec(text))) {
    const close = text.indexOf("</td>", m.index);
    out.push([m.index, close === -1 ? text.length : close]);
  }
  return out;
}

const lineAt = (text: string, at: number) => text.slice(0, at).split("\n").length;

/** True when the line holding `at`, or the comment block above it, opts out. */
function optedOut(text: string, at: number): boolean {
  const lines = text.slice(0, at).split("\n");
  const i = lines.length - 1;
  const all = text.split("\n");
  if (OPT_OUT.test(all[i] ?? "")) return true;
  for (let up = i - 1; up >= 0; up--) {
    const above = (all[up] ?? "").trim();
    if (!above.startsWith("//") && !above.startsWith("*") && !above.startsWith("/*")) break;
    if (OPT_OUT.test(above)) return true;
  }
  return false;
}

export function scanPillAlignment(file: string, text: string): PillAlignmentSite[] {
  const out: PillAlignmentSite[] = [];

  for (const [start, end] of cellRanges(text)) {
    const cell = text.slice(start, end);

    // A cell that carries its own negative left margin is the workaround this
    // exists to prevent, whether or not its pill is correct.
    const cellOpen = cell.slice(0, cell.indexOf(">") === -1 ? cell.length : cell.indexOf(">") + 1);
    if (/-ml-/.test(cellOpen) && /<Pill\b/.test(cell) && !optedOut(text, start)) {
      out.push({
        file,
        line: lineAt(text, start),
        why: "a table cell holding a Pill carries its own negative margin; the pill's `alignToColumn` owns that offset",
      });
    }

    // Each `<Pill` in the cell, with the props of its opening tag.
    const pills: { at: number; props: string }[] = [];
    const re = /<Pill\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(cell))) {
      const gt = cell.indexOf(">", m.index);
      pills.push({ at: start + m.index, props: cell.slice(m.index, gt === -1 ? cell.length : gt) });
    }

    pills.forEach((pill, i) => {
      if (optedOut(text, pill.at)) return;
      const aligned = /\balignToColumn\b/.test(pill.props);
      if (i === 0 && !aligned) {
        out.push({
          file,
          line: lineAt(text, pill.at),
          why: "a Pill starting a table cell needs `alignToColumn`, or its label sits 9px right of the column header's",
        });
      }
      if (i > 0 && aligned) {
        out.push({
          file,
          line: lineAt(text, pill.at),
          why: "only the FIRST Pill in a cell aligns to the column; pulling a later one eats the gap between them",
        });
      }
    });
  }

  return out;
}
