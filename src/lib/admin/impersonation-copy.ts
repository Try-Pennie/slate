/**
 * What "view as" does, in the one place that says it (#1795).
 *
 * This sentence used to live inside the free text "View as somebody not in this
 * list" panel, and a grep confirmed it appeared nowhere else in the app. Deleting
 * that panel would have taken the only explanation of the most consequential
 * action in the admin area with it, and #1794 is about to fold the per row
 * control into a three dot menu, which would leave it behind a glyph with no
 * explanation anywhere.
 *
 * So it is a constant rather than JSX: removing it now breaks a build instead of
 * quietly leaving the control unexplained, and whichever surface ends up owning
 * the control (a note above the table today, a confirm step on the action if
 * #1794 goes that way) renders THIS rather than writing its own version.
 */
export const IMPERSONATION_WARNING =
  "While viewing as someone, what you do happens as them, so be careful. A banner stays up the whole time with a way back to yourself.";
