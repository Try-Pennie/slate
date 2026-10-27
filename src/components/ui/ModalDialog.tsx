"use client";

import { useEffect, useLayoutEffect, useRef } from "react";

/**
 * The scrim: the dialog element itself fills the screen in 55% NAVY, not black (#1903:
 * Slate has no hard black anywhere, and 55% navy dims the page to within a few points of
 * the 45% black it replaced). Every user agent default a modal dialog carries (its margin,
 * border, padding, size caps, Canvas colours and a grey ::backdrop of its own) is reset
 * here. `open:flex` rather than `flex`, which would override the closed dialog's display
 * none.
 */
export const MODAL_DIALOG_SCRIM_CLASS =
  "fixed inset-0 z-50 m-0 h-full max-h-none w-full max-w-none items-center justify-center border-0 bg-[color-mix(in_srgb,var(--pennie-navy)_55%,transparent)] p-4 text-fg open:flex backdrop:bg-transparent";

/** The panel the question sits in. */
export const MODAL_DIALOG_PANEL_CLASS =
  "w-full max-w-115 rounded-[var(--radius-lg)] border border-border bg-surface px-6 py-5 shadow-[var(--shadow-lg)]";

/**
 * Slate's one modal dialog (#3081, extracted from UnsavedGuard for #4205), a NATIVE
 * modal. The div UnsavedGuard used to draw carried aria-modal="true" and delivered none
 * of what that promises: Tab walked out of it into the page behind, the page stayed
 * clickable under the scrim, and closing it dropped focus on the body. showModal() puts
 * the dialog in the top layer and makes everything else inert, so containing focus is
 * the platform's job rather than a trap written here. A layout effect, so it is modal
 * before the first paint. jsdom has the element and implements neither method; there it
 * is merely marked open, which is all a test can observe anyway.
 *
 * Drawn only while `open`, so a closed dialog takes no place in the page. Escape and the
 * platform's own cancel (a phone's back gesture) both ask `onClose`, and closing stays
 * the CALLER's decision: a caller that refuses (a booking being placed) simply stays
 * open, and the dialog never closes behind the state's back. Focus lands on
 * `initialFocusRef` (the safe choice, never the one that discards or commits) and goes
 * back to `returnFocusRef` once the dialog has gone, since an element under a modal is
 * inert and cannot take focus until then.
 */
export function ModalDialog({
  open,
  onClose,
  labelledBy,
  describedBy,
  initialFocusRef,
  returnFocusRef,
  children,
}: {
  open: boolean;
  /** Escape or the platform's cancel. The caller closes it, or not. */
  onClose: () => void;
  /** The id of the dialog's title. */
  labelledBy: string;
  describedBy?: string;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  /** Where focus goes once the dialog has closed. */
  returnFocusRef?: React.RefObject<HTMLElement | null>;
  children: React.ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const wasOpen = useRef(false);

  useLayoutEffect(() => {
    const d = dialogRef.current;
    if (!open || !d || d.open) return;
    if (typeof d.showModal === "function") d.showModal();
    else d.setAttribute("open", "");
  }, [open]);

  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      initialFocusRef?.current?.focus({ preventScroll: true });
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    const back = returnFocusRef?.current;
    // After the dialog has gone: a modal makes the page inert, and an inert element
    // cannot take focus.
    const t = window.setTimeout(() => back?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [open, initialFocusRef, returnFocusRef]);

  if (!open) return null;
  return (
    <dialog
      ref={dialogRef}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      className={MODAL_DIALOG_SCRIM_CLASS}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        // Handled here, so the dialog's own cancel never also fires.
        e.preventDefault();
        onClose();
      }}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className={MODAL_DIALOG_PANEL_CLASS}>{children}</div>
    </dialog>
  );
}
