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

export type PillVariant =
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
 * `font-semibold` except `role-agent`, which is deliberately unweighted. Putting
 * it in the base and overriding it here would leave the winner to be decided by
 * the order Tailwind happens to emit the two utilities in, which is invisible at
 * the call site (L509).
 */
const VARIANT_CLS: Record<PillVariant, string> = {
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
}: {
  variant: PillVariant;
  children: ReactNode;
  className?: string;
  title?: string;
  /**
   * Set on a pill that starts a TABLE CELL, so its label lines up with the
   * column header's rather than 9px right of it (#1821).
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
      {children}
    </span>
  );
}
