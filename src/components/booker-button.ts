/**
 * The booker's one button class string (#2562).
 *
 * The booker wrote `inline-flex min-h-{11,12,14} items-center justify-center
 * rounded-lg px-{4,5} text-sm font-semibold ...` by hand at twelve sites,
 * differing only in the colour classes on the end. A spacing, radius or target
 * size change to the lead facing buttons meant a file wide find and replace, and
 * a site left behind is a visible inconsistency on the surface a customer sees.
 *
 * It is NOT `src/components/ui/styles.ts`, which the admin pages share, and that
 * is deliberate rather than an oversight. Those `pn-btn` classes take their
 * colour from the page's own theme; the booker is embedded in somebody else's
 * page, so it carries its OWN palette object (`PALETTE` in `Booker.tsx`, picked
 * by the `theme` prop and overridden per booking by a host's brand colour). The
 * palette is therefore an ARGUMENT here rather than something this module reads:
 * one component, whichever half of the palette the booker is wearing.
 *
 * Pure, and in a `.ts` of its own rather than beside the component, so the guard
 * that keeps the string here (`scripts/test-booker-button-single-source.ts`) can
 * ask what this actually composes rather than asserting on a copy of it (L63).
 */

/** The half of the booker's palette a button needs. */
export interface BookerButtonPalette {
  /** The border colour a secondary button outlines itself with. */
  toggleBorder: string;
  /** Body text, which is a secondary button's label. */
  body: string;
  /** The hover wash under a secondary button. */
  navHover: string;
  /** The sky fill and its label: the one action colour. */
  confirm: string;
  /** Quiet text, which is what an underlined, rarely pressed control wears. */
  muted: string;
}

/**
 * What the press is.
 *
 * `primary` is the sky fill and there is at most one on screen at a time, since
 * sky is the only action colour and a second one is a second claim about what to
 * press. `quiet` is the underlined treatment for the rare and reversible, and
 * `danger` for the rare and irreversible, which is why they read differently.
 */
export type BookerButtonVariant = "primary" | "secondary" | "danger" | "quiet";

/**
 * How big the box is.
 *
 * Every size clears 44px, because the booker is read on a phone as often as on a
 * desktop. `lg` is the confirm at the end of the details step, the one button on
 * its screen; `md` is the standard panel control; `sm` is a control inside a
 * message, where a full sized button would read as the point of the panel.
 */
export type BookerButtonSize = "sm" | "md" | "lg";

/** Everything every button has: the box, the label weight, the disabled state. */
const BASE = "inline-flex items-center justify-center font-semibold disabled:opacity-60";

const SIZES: Record<BookerButtonSize, string> = {
  sm: "min-h-11 rounded-lg px-4 text-sm",
  md: "min-h-12 rounded-lg px-5 text-sm",
  lg: "min-h-14 rounded-xl px-4 text-base",
};

/**
 * The destructive fill, its label and its hover, in ONE literal that every rose
 * button reads: the booker's `danger` variant and the lead's cancel confirm on
 * the manage page. They were two hand written copies of the same string, and
 * both hovered with `hover:opacity-90`, which faded the label AND the rose over
 * whatever was behind the button: 4.39:1 in light, under AA, in the state a
 * pointer is in at the moment of pressing (#2836). The hover is an opaque step
 * now, `--error-hover`, flipped with the theme beside `--error` and
 * `--fg-on-error`, so it has one value wherever the button lands.
 *
 * `scripts/test-contrast.ts` finds this literal itself and measures its rest
 * AND hover pairs in both themes over every surface a button can sit on, so an
 * opacity fade put back here fails the build rather than a lead's eyes.
 */
export const DANGER_FILL_CLASSES =
  "bg-[var(--error)] text-[var(--fg-on-error)] transition-colors hover:bg-[var(--error-hover)]";

/**
 * The colour half. Three of the four read the palette they are handed; `danger`
 * reads `--error` and its label `--fg-on-error` directly, because the rose and
 * the label on it flip with the theme together (white on the light rose,
 * graphite on the lightened dark one, #2611) rather than living in the palette.
 */
function variantClasses(variant: BookerButtonVariant, p: BookerButtonPalette): string {
  switch (variant) {
    case "primary":
      return p.confirm;
    case "secondary":
      return `border ${p.toggleBorder} ${p.body} ${p.navHover}`;
    case "danger":
      return DANGER_FILL_CLASSES;
    case "quiet":
      return `underline underline-offset-2 hover:no-underline ${p.muted}`;
  }
}

export interface BookerButtonClassInput {
  palette: BookerButtonPalette;
  variant: BookerButtonVariant;
  size?: BookerButtonSize;
  /** The call site's own LAYOUT classes (margin, width, a group marker). */
  className?: string;
}

/** The class string a booker button wears. */
export function bookerButtonClass({
  palette,
  variant,
  size = "md",
  className,
}: BookerButtonClassInput): string {
  return [BASE, SIZES[size], variantClasses(variant, palette), className]
    .filter(Boolean)
    .join(" ");
}
