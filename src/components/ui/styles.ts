/**
 * Shared Pennie-token style constants for the internal pages (/admin, /me).
 * Single source of truth — both pages import these instead of declaring their
 * own copies. Presentation only; token-driven (no raw hex).
 */

export const labelCls = "block text-xs font-semibold text-fg-muted";

export const inputCls =
  "mt-1 w-full rounded-sm border border-border bg-[var(--field)] px-3 text-fg " +
  "h-[44px] placeholder:text-fg-muted";

// Cards lean on a soft shadow in light mode; shadows vanish on dark, so a
// subtle border restores the card edge there.
export const cardCls =
  "rounded-md bg-surface shadow-xs p-6 dark:border dark:border-border";

export const btnCls = "pn-btn pn-btn--small pn-btn--primary";

export const btnSecondaryCls = "pn-btn pn-btn--small pn-btn--additional";

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
