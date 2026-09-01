import type { ReactNode } from "react";

/**
 * Presentation-only role/status pill (DS badges: 999px radius, 24px tall,
 * 13px semibold). Owned by Task 3.1; consumed by the admin (role/status
 * pills) and me (bookable pill) pages. No logic, no data.
 *
 * The ink-fill `role-admin` variant gets a dark treatment (outline +
 * sky-soft text) because a navy fill is invisible on the dark navy page.
 *
 * ON A DARK BAND, pass `onDark` (#1054). The transparent variants (`role-agent`,
 * `outline`) draw their label in `--fg`, which follows the PAGE theme, so they are
 * only legible on the page's own background. Placed inside a band that paints its
 * own dark fill they keep the light theme's graphite label: measured at 1.28:1 on
 * the agent detail page's navy identity band, which is an invisible pill rather
 * than a low-contrast one.
 *
 * This is the pair problem (L213): a call site that overrides only the BACKGROUND
 * silently keeps the base variant's foreground, and nothing reports it because both
 * halves are individually correct. `onDark` overrides the pair, so a call site has
 * the right thing to reach for instead of inventing a className, and the token
 * contrast guard covers the pairing it produces.
 */

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
 * The transparent variants, whose legibility depends on what is BEHIND them rather
 * than on a fill they carry. Only these need the `onDark` override; every other
 * variant paints its own background and is self-contained.
 */
const TRANSPARENT_VARIANTS: readonly PillVariant[] = ["role-agent", "outline"];

/** The pairing for a transparent pill sitting on a dark band: cream label on a cream
 *  hairline. Both halves change together, which is the entire point. */
const ON_DARK_CLS = "border-pennie-beige/40 text-pennie-beige";

const VARIANT_CLS: Record<PillVariant, string> = {
  "role-agent": "border-border text-fg",
  "role-manager": "bg-pennie-sky-soft text-pennie-navy",
  // A step above manager: navy outline (not a fill) so it reads as elevated
  // without competing with admin's solid fill or the manager's soft wash.
  "role-team_lead":
    "border border-pennie-navy text-pennie-navy " +
    "dark:border-[var(--pennie-sky-soft)] dark:text-[var(--pennie-sky-soft)]",
  "role-admin":
    "bg-pennie-navy text-pennie-beige " +
    "dark:bg-transparent dark:border-border dark:text-[var(--pennie-sky-soft)]",
  // Top tier: navy fill like admin but with the sky accent text, so it reads
  // as "admin, elevated" without borrowing the CTA sky fill.
  "role-super_admin":
    "bg-pennie-navy text-[var(--pennie-sky-soft)] " +
    "dark:bg-transparent dark:border-[var(--pennie-sky-soft)] dark:text-[var(--pennie-sky-soft)]",
  // 3.V AA fix: green-deep on green-wash is 2.44:1 at 13px (axe color-contrast
  // fail). Graphite on the wash is 11.58:1 and stays put in dark (both are raw
  // tokens); the wash + label text carry the status meaning.
  "status-ok":
    "bg-[var(--pennie-green-wash)] text-pennie-graphite",
  // 3.V AA fix: rose on the 12% rose wash is 4.34:1 (fail). Plain rose text +
  // rose outline passes both themes (5.14:1 on white, 4.96:1 dark via the
  // lightened --error flip) — same recipe as the 2.3 form-error deviation.
  "status-error": "border-[var(--error)] text-error",
  "status-pending": "bg-pennie-sky-soft text-pennie-blue",
  outline: "border-border text-fg",
};

export function Pill({
  variant,
  children,
  className,
  title,
  onDark,
}: {
  variant: PillVariant;
  children: ReactNode;
  className?: string;
  title?: string;
  /** Set when the pill sits on a band that paints its OWN dark fill, so a
   *  transparent variant does not keep the page theme's dark label (#1054). */
  onDark?: boolean;
}) {
  const variantCls =
    onDark && TRANSPARENT_VARIANTS.includes(variant) ? ON_DARK_CLS : VARIANT_CLS[variant];
  return (
    <span
      title={title}
      className={`inline-flex h-6 items-center gap-1 rounded-pill border border-transparent px-2 text-[13px] font-semibold leading-none ${variantCls}${className ? ` ${className}` : ""}`}
    >
      {children}
    </span>
  );
}
