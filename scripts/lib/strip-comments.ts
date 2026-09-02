/**
 * Comments out of a TS/TSX source before anything looks for MARKUP in it.
 *
 * This exists because the same mistake was made four times in two files while
 * #1745 and #1748 were being written, and it is a mistake that fails in the green
 * direction. A file that renders `<main id="main" tabIndex={-1}>` almost always
 * also EXPLAINS itself by naming that tag in a doc comment, and the explanation
 * comes first in the file. A scan of the raw text then returns the four characters
 * out of a sentence as "the tag", finds no `tabIndex` in it, and reports a
 * perfectly correct file as broken; the same scan against a check phrased the
 * other way reports a broken file as correct.
 *
 * Both directions were observed: `PageShell.tsx` describing its own `<main>` and
 * `max-w-4xl`, and `src/app/admin/layout.tsx` describing the target it renders.
 *
 * Deliberately simple: block comments and whole-line `//` comments, which covers
 * every JSX comment (`{/* ... *\/}`) and every doc block. It does not try to
 * understand strings containing comment markers, because a scanner is not a parser
 * and pretending otherwise would trade one silent wrong answer for another.
 */
export function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}
