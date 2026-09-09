/**
 * The page shell around a STANDALONE booker (#2159).
 *
 * Dan, 2026-09-09: the booker sat hard against the top of the window with the
 * rest of the page empty beneath it, which reads as content that failed to load
 * rather than as a finished screen.
 *
 * Centring a card in the viewport has one way to go wrong, and it is silent: the
 * card can end up ABOVE the scroll origin, so its top is unreachable and nothing
 * reports a fault. The booker reaches that size in ordinary use, because it grows
 * a lot once a day is picked and a column of times renders, and a laptop window is
 * short. Measured in Chrome at 1280 by 360 against a 475px card, all four
 * combinations:
 *
 *   minimum height + auto margin ........ card top   32   (shipped)
 *   minimum height + justify-center ..... card top   32
 *   FIXED height   + justify-center ..... card top  -89   unreachable
 *   FIXED height   + auto margin ........ card top   32
 *
 * So two rules, and they are not the same rule:
 *
 * 1. **The height is a MINIMUM, never fixed.** That is what actually keeps the
 *    page safe today: a container with `min-height` grows past the viewport, so
 *    there is no negative free space for any centring property to distribute, and
 *    the page simply scrolls. `h-dvh` or `h-screen` here is the defect.
 * 2. **The centring is an AUTO MARGIN anyway.** An auto margin resolves to zero
 *    when the free space is negative, so it is the one technique that stays
 *    reachable even if somebody later makes the height fixed. It costs nothing to
 *    prefer it, and rule 1 is one careless edit away from being lost.
 *
 * **The embed gets none of this.** An embedded booker is inside an iframe whose
 * height the host sets from the `slate:resize` message the Booker posts, so giving
 * it the viewport's height would have it report a height set by the iframe's own
 * viewport rather than by its content, and the host would size the frame to that
 * forever. `mainClassFor` returns nothing at all for the embed, deliberately.
 */

/** The page's own element: a full-height column, so there is space to centre in
 *  and the legal footer can sit at the bottom of it. `min-h-`, never `h-`. */
export const STANDALONE_MAIN = "flex min-h-dvh flex-col bg-bg";

/** The booker's wrapper. `my-auto` takes the leftover space above and below in
 *  equal shares, and gives it all back the moment there is none. */
export const STANDALONE_CONTENT = "my-auto w-full px-4 py-8";

/** A viewport height that is FIXED rather than a floor. This is the one that puts
 *  a tall card above the scroll origin.
 *
 *  The lookbehinds are load bearing: `\bh-dvh\b` matches INSIDE `min-h-dvh`,
 *  because the hyphen before the `h` is a word boundary, so without them the
 *  judge refuses the very class the shell is built on. Its own positive control
 *  is what caught that. */
const FIXED_VIEWPORT_HEIGHT = /(?<!min-)(?<!max-)\bh-(?:dvh|svh|lvh|screen|full)\b/;

/** The centring properties that distribute negative free space, as whole words so
 *  `items-center` is caught and `items-centered` (were anyone to write it) is not. */
const CLIPPING_CENTRE =
  /\b(?:items-center|justify-center|content-center|place-items-center|place-content-center|self-center)\b/;

/**
 * Whether a class string centres in a way that stays reachable at any content
 * height, which needs BOTH rules above: no fixed viewport height, and no centring
 * property that can take a negative share.
 *
 * It answers about the SHELL only. Inside the booker card, `items-center` on a row
 * of controls is right and common; the rule is about the one element that has the
 * whole window to centre within, because that is the only place the overflow has
 * nowhere to go.
 */
export function centresWithoutClipping(classes: string): boolean {
  return !FIXED_VIEWPORT_HEIGHT.test(classes) && !CLIPPING_CENTRE.test(classes);
}

/** The page element's classes. The embed gets none: see the note above. */
export function mainClassFor(embedded: boolean): string {
  return embedded ? "" : STANDALONE_MAIN;
}
