/**
 * The one place an internal page's content width is decided (#1745).
 *
 * Before this, all 13 internal pages hard coded their own cap on their own
 * `<main>` and disagreed with each other: `/me` at 672px, `/admin` at 896px,
 * `/admin/bucket-availability` at 1152px. Two consequences, both visible. The
 * admin home used about half of a wide window while the rest sat as empty
 * margin, and moving between pages changed the content width underneath you.
 *
 * There are deliberately only TWO widths. A third variant would recreate the
 * problem this exists to fix, thirteen pages each picking a number, one
 * indirection further along.
 *
 * The reading-width constraint is NOT applied here. Capping the whole page at a
 * comfortable line length is what produced the narrow column in the first place:
 * it makes a paragraph readable by making a table unusable. It belongs on the
 * prose instead, which is what `proseCls` in ./styles.ts is for.
 *
 * This also owns the skip-link target (`id="main"`, `tabIndex={-1}`), which used
 * to be repeated on every page. `scripts/test-skip-link-target.ts` follows it
 * here rather than reading each page's own text.
 */

export const PAGE_WIDTHS = {
  /**
   * The default. Wide enough to fill a laptop window and to leave room for the
   * admin sidebar, and still capped so a table on an ultrawide display does not
   * run the full width of the glass.
   */
  wide: "max-w-[80rem]",
  /**
   * Opt in, for a surface that is genuinely one column of form. Stretching a
   * stack of time pickers across a wide window puts every control on the left
   * and reads worse than a column, so `/me` and the record detail pages keep
   * one.
   */
  narrow: "max-w-[48rem]",
} as const;

export type PageWidth = keyof typeof PAGE_WIDTHS;

export function PageShell({
  width = "wide",
  children,
}: {
  width?: PageWidth;
  children: React.ReactNode;
}) {
  return (
    <main
      id="main"
      tabIndex={-1}
      className={`mx-auto w-full min-w-0 ${PAGE_WIDTHS[width]} space-y-8 px-6 py-10 sm:px-8`}
    >
      {children}
    </main>
  );
}
