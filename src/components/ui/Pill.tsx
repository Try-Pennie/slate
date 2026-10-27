import type { ReactNode } from "react";

/**
 * Presentation-only role/status pill (DS badges: 999px radius, 24px tall,
 * 13px semibold). Owned by Task 3.1; consumed by the admin (role/status
 * pills) and me (bookable pill) pages. No logic, no data.
 *
 * The ink-fill `role-admin` variant gets a dark treatment (outline +
 * sky-soft text) because a navy fill is invisible on the dark navy page.
 *
 * THERE IS NO `onDark` ANY MORE (#1838). It existed because the agent detail page
 * put three pills inside a navy identity band, where a transparent variant drew
 * its `--fg` label on navy at 1.28:1: an invisible pill rather than a low
 * contrast one (#1054, the pair problem, L213). #1838 turned every page header
 * into an ordinary card, which left that prop with zero call sites, and a
 * mechanism with no users plus a docstring arguing for its necessity is exactly
 * what the next reader argues with instead of deleting (L29).
 *
 * The navy surfaces that remain (the login brand panel, the impersonation banner
 * and its dropped session notice, the time off stat grid) render no Pill at all,
 * which is why nothing needs it. If a pill is ever put on one of them the pair
 * problem returns; `scripts/test-contrast.ts` still holds graphite on navy as a
 * FORBIDDEN pairing, so that failure is recorded even with the remedy gone.
 *
 * IN A TABLE CELL, pass `alignToColumn` (#1821). The pill's label sits 9px in
 * from its own edge (a 1px transparent border plus 8px of padding), so a pill
 * starting a cell put its word 9px right of the column header's word: the header
 * lined up with the pill's rounded edge rather than with its label. That is the
 * pill's geometry, not the table's, so the cancellation lives here rather than as
 * a negative margin every table call site has to remember (L550).
 *
 * A pill LED BY A MARK cancels the same 9px (#3031). What lines up with the
 * header is the pill's CONTENT, whatever leads it: the word in the Role column,
 * the dot in the Bookable one. #2082 cancelled the mark and the gap as well, so
 * the word lined up, but the bubble then hung 21px left, nine of them outside its
 * own column, and Dan read the header as not lined up with its pill at all. One
 * cancellation for every pill also means every bubble in a table overhangs its
 * column edge by the same amount.
 */

/**
 * The pill's own transparent border, in px. It exists so a variant that draws a
 * visible border does not change the pill's size, and it counts toward how far
 * the label sits from the pill's edge.
 */
const BORDER_PX = 1;

/** The pill's horizontal padding, in px. `px-2` in the class list below. */
const PAD_X_PX = 8;

/**
 * How far the pill's LABEL sits from the pill's left edge (#1821).
 *
 * Derived rather than typed, because `alignToColumn` cancels exactly this and a
 * hand written number would drift the moment the padding changed. The classes it
 * describes are asserted in Pill.test.tsx, so these two constants cannot quietly
 * stop being true of the pill they claim to measure.
 */
export const PILL_TEXT_INSET_PX = BORDER_PX + PAD_X_PX;

/**
 * The cancellation. Written as a literal because Tailwind scans source text for
 * class names and cannot see a computed one; the test holds it equal to
 * `PILL_TEXT_INSET_PX`, which is what keeps the literal honest.
 */
const ALIGN_TO_COLUMN_CLS = "-ml-[9px]";

/**
 * How far the LABEL sits below where `items-center` puts it, so the word is
 * centred by its letters rather than by its box (#2081).
 *
 * `items-center` centres each child's box, and a word's box is its line box,
 * which reserves descender space that most labels here never use. So the letters
 * sit above the centre of their own box, and a mark centred beside them reads as
 * low even though both are perfectly centred in the pill (L591).
 *
 * MEASURED, not chosen. In Chrome on the pill's own type (PP Mori SemiBold 13px)
 * the font reports ascent 10, descent 3, cap height 9.1, so the letters' centre
 * sits (ascent - descent - capHeight) / 2 = 1.05px above the box centre, in both
 * the Yes and No states. Re-measure with a canvas TextMetrics read on a rendered
 * pill if the pill's font, size or weight changes; Pill.test.tsx carries the
 * arithmetic.
 *
 * THE LABEL MOVES, NOT THE MARK. Putting the mark on the word's centre instead
 * would align the pair to each other and leave both riding high in the oval.
 * Moving the label down puts the word's optical centre where the mark already
 * is, which is the pill's centre, so the two are centred on each other AND in
 * the oval. Every pill's label gets it, not only the one with a mark, or a
 * bookable pill's word would sit a pixel below the role pill beside it.
 */
export const PILL_LABEL_OPTICAL_NUDGE_PX = 1;

/** Literal for the same reason as the cancellation above: Tailwind reads source. */
const LABEL_OPTICAL_CLS = "relative top-[1px]";

export type PillVariant =
  | "role-coordinator"
  | "role-agent"
  | "role-manager"
  | "role-team_lead"
  | "role-admin"
  | "role-super_admin"
  | "status-ok"
  | "status-error"
  | "status-pending"
  | "outline";

/**
 * WEIGHT LIVES HERE, NOT IN THE BASE (#1844). Every variant carries its own
 * `font-semibold` except `role-agent` and `role-coordinator`, which are deliberately
 * unweighted. Putting
 * it in the base and overriding it here would leave the winner to be decided by
 * the order Tailwind happens to emit the two utilities in, which is invisible at
 * the call site (L509).
 */
const VARIANT_CLS: Record<PillVariant, string> = {
  // #4205: a scheduling coordinator sits below agent, off the ladder, so it is no
  // more elevated than the floor and draws exactly as agent does.
  "role-coordinator": "text-fg-muted",
  // THE FLOOR OF THE ROLE LADDER, and the only member that draws no chrome
  // (#1844). Agent is "no elevation", and on a 117 person roster it is nearly
  // every row, so a bordered semibold pill gave the least informative value the
  // heaviest treatment on the page. Muted plain text matches the Manager column
  // beside it and makes the four elevated roles easier to pick out, not harder:
  // this is a decision about the BASE of an ordered set, and Pill.test.tsx holds
  // every role above it to still reading as elevated (L545).
  "role-agent": "text-fg-muted",
  "role-manager": "bg-pennie-sky-soft text-pennie-navy font-semibold",
  // A step above manager: navy outline (not a fill) so it reads as elevated
  // without competing with admin's solid fill or the manager's soft wash.
  "role-team_lead":
    "border border-pennie-navy text-pennie-navy font-semibold " +
    "dark:border-[var(--pennie-sky-soft)] dark:text-[var(--pennie-sky-soft)]",
  "role-admin":
    "bg-pennie-navy text-pennie-beige font-semibold " +
    "dark:bg-transparent dark:border-border dark:text-[var(--pennie-sky-soft)]",
  // Top tier: navy fill like admin but with the sky accent text, so it reads
  // as "admin, elevated" without borrowing the CTA sky fill.
  "role-super_admin":
    "bg-pennie-navy text-[var(--pennie-sky-soft)] font-semibold " +
    "dark:bg-transparent dark:border-[var(--pennie-sky-soft)] dark:text-[var(--pennie-sky-soft)]",
  // 3.V AA fix: green-deep on green-wash is 2.44:1 at 13px (axe color-contrast
  // fail). Graphite on the wash is 11.58:1 and stays put in dark (both are raw
  // tokens); the wash + label text carry the status meaning.
  "status-ok":
    "bg-[var(--pennie-green-wash)] text-pennie-graphite font-semibold",
  // 3.V AA fix: rose on the 12% rose wash is 4.34:1 (fail). Plain rose text +
  // rose outline passes both themes (5.14:1 on white, 4.96:1 dark via the
  // lightened --error flip) — same recipe as the 2.3 form-error deviation.
  "status-error": "border-[var(--error)] text-error font-semibold",
  "status-pending": "bg-pennie-sky-soft text-pennie-blue font-semibold",
  outline: "border-border text-fg font-semibold",
};

/**
 * Every variant the pill can be, derived from the map that styles them rather
 * than listed beside it, so a guard over "all variants" cannot go stale against
 * a variant added later (L41, L96).
 */
export const ALL_VARIANTS = Object.keys(VARIANT_CLS) as PillVariant[];

export function Pill({
  variant,
  children,
  className,
  title,
  alignToColumn,
  mark,
}: {
  variant: PillVariant;
  children: ReactNode;
  className?: string;
  title?: string;
  /**
   * A small leading shape drawn before the label (#2081), such as the bookable
   * pill's filled disc or ring.
   *
   * It is a prop rather than just another child because the pill treats the two
   * differently: the mark is centred on the pill's own centre, and the label is
   * centred on its letters. Passing a mark as a child would put it inside that
   * optical nudge and move the pair together, which is the same pair.
   */
  mark?: ReactNode;
  /**
   * Set on a pill that starts a TABLE CELL, so its content (the label, or the
   * mark when one leads) lines up with the column header's rather than 9px right
   * of it (#1821, #3031).
   *
   * Only the pill at the START of a cell. A second pill beside it is not at the
   * column's edge, and pulling it would eat the gap between the two. A pill
   * inline in a sentence or in a flex row is correctly inset and must not set
   * this.
   */
  alignToColumn?: boolean;
}) {
  const variantCls = VARIANT_CLS[variant];
  return (
    <span
      title={title}
      className={`inline-flex h-6 items-center gap-1 rounded-pill border border-transparent px-2 text-[13px] leading-none ${
        alignToColumn ? `${ALIGN_TO_COLUMN_CLS} ` : ""
      }${variantCls}${className ? ` ${className}` : ""}`}
    >
      {mark && (
        // A box of a size the pill knows, so the mark's footprint does not depend
        // on whatever the caller happened to draw inside it (#2082).
        <span aria-hidden="true" data-pill-mark="" className="inline-flex h-2 w-2 shrink-0 items-center justify-center">
          {mark}
        </span>
      )}
      <span data-pill-label="" className={LABEL_OPTICAL_CLS}>
        {children}
      </span>
    </span>
  );
}
