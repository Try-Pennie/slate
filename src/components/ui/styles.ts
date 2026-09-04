/**
 * Shared Pennie-token style constants for the internal pages (/admin, /me).
 * Single source of truth — both pages import these instead of declaring their
 * own copies. Presentation only; token-driven (no raw hex).
 */

export const labelCls = "block text-xs font-semibold text-fg-muted";

export const inputCls =
  "mt-1 w-full rounded-sm border border-border bg-[var(--field)] px-3 text-fg " +
  "h-[44px] placeholder:text-fg-muted";

/**
 * A select's box (#1854).
 *
 * NOT `inputCls`, and that is the whole point. A select and a text input cannot
 * share one horizontal padding and both look right: an input spends its right
 * padding on empty space after the text, while a select spends it on the arrow.
 * Every select in the app took its padding from the input's class, so the arrow
 * sat hard against the right border with nothing between it and the edge, on
 * every filter, form and settings screen at once.
 *
 * So a select reserves MORE on the right than on the left. Measured in a browser
 * rather than guessed: `padding-right` really does move the native arrow inward,
 * and at 36px it clears the edge while a long option's text still stops short of
 * it. Widening `inputCls` was the other way to reach this and is the wrong one,
 * since it would put unwanted empty space inside every text field in the app.
 *
 * THE ARROW IS STILL THE BROWSER'S. Drawing our own would make the spacing exact
 * across browsers, and #1849 will do exactly that, because the picker replacing
 * these has to draw a chevron regardless and needs a wrapper element per control
 * to position it. Doing it here would be that work twice. `scripts/test-select-not-input.ts`
 * holds the two classes apart so the padding decision survives into it.
 */
export const selectCls =
  "mt-1 w-full rounded-sm border border-border bg-[var(--field)] pl-3 pr-9 text-fg " +
  "h-[44px]";

// Cards lean on a soft shadow in light mode; shadows vanish on dark, so a
// subtle border restores the card edge there.
export const cardCls =
  "rounded-md bg-surface shadow-xs p-6 dark:border dark:border-border";

export const btnCls = "pn-btn pn-btn--small pn-btn--primary";

export const btnSecondaryCls = "pn-btn pn-btn--small pn-btn--additional";

/**
 * A control whose press cannot simply be undone (#1875).
 *
 * Deactivating an agent wore `btnSecondaryCls`, the identical neutral treatment
 * as Reactivate beside it, so the two opposite decisions looked the same. This is
 * the rose outline defined in globals.css; its contrast in both themes is
 * asserted in `scripts/test-contrast.ts` rather than assumed.
 *
 * Reach for it only where the press is genuinely hard to reverse. A destructive
 * treatment on an ordinary control is how a reader learns to ignore the colour.
 */
export const btnDangerCls = "pn-btn pn-btn--small pn-btn--danger";

/**
 * Reading width for a block of prose (#1745). The page container is wide so
 * tables and multi-column content can use the window; a sentence set across the
 * whole of it is unreadable, so the constraint lives on the prose rather than on
 * the page. 65ch is about 75 characters, the top of the comfortable range.
 *
 * Put it on the descriptive paragraph under a heading, never on the container
 * holding a table or a control grid.
 */
export const proseCls = "max-w-[65ch]";
