/**
 * Shared Pennie-token style constants for the internal pages (/admin, /me).
 * Single source of truth — both pages import these instead of declaring their
 * own copies. Presentation only; token-driven (no raw hex).
 */

export const labelCls = "block text-xs font-semibold text-fg-muted";

export const inputCls =
  "mt-1 w-full rounded-sm border border-border bg-surface px-3 text-fg " +
  "h-[44px] placeholder:text-fg-muted";

export const cardCls = "rounded-md bg-surface shadow-xs p-6";

export const btnCls = "pn-btn pn-btn--small pn-btn--primary";

export const btnSecondaryCls = "pn-btn pn-btn--small pn-btn--additional";
