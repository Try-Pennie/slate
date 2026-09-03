"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";
import { AnchoredPanel } from "@/components/ui/AnchoredPanel";

/**
 * One menu of actions for one row of a table (#1794).
 *
 * Dan, 2026-09-03, on the agent roster: "let's collapse this two into a menu in
 * each line... like a 3 dot menu is fine". The controls spelled the agent's whole
 * name into a narrow column, so "View as Kenneth Johnson" wrapped to three lines
 * and every row was a different height. A glyph is a fixed size, so the row stops
 * depending on how long somebody's name is.
 *
 * THE TRIGGER CARRIES THE ROW'S IDENTITY even though the glyph does not. The
 * label it replaced named the agent for a reason: a table of identical buttons is
 * a control addressed by position rather than by identity (L237). On screen the
 * row supplies that context, but to a screen reader 136 buttons called "More"
 * supply none, so `label` is required and is expected to name the row. Items
 * inside may drop the name, because the open menu is already scoped to one row.
 *
 * IT DOES NOT CLOSE WHEN AN ITEM IS ACTIVATED, deliberately. The roster's "View
 * as" is a form submission rather than a link, and it is the action where losing
 * the in flight feedback matters most, since it swaps who you are logged in as.
 * Closing on activation would unmount the submit button mid flight and take its
 * pending state with it. Every real item here navigates, so the menu goes away
 * with the page; Escape and a click outside are the deliberate ways to dismiss
 * it.
 *
 * WHY THIS IS NOT `AccountMenu`, which also opens a panel from a button in this
 * app: that one's content is a settings panel (an identity, a calendar status, a
 * theme fieldset), not a list of actions, so the arrow key roving focus this
 * implements would have nothing to rove over and would fight the fieldset. Two
 * components because they are two patterns, and this note is here so the next
 * reader does not merge them and find out the hard way.
 *
 * Items are supplied by the caller and must each carry `role="menuitem"`; this
 * finds them at open time rather than cloning children, so an item can be any
 * element (a submit button inside its own form, a link) without this component
 * knowing about it.
 */
export function RowActionsMenu({
  label,
  children,
}: {
  /** The trigger's accessible name. Must name the row, e.g. "Actions for Ada". */
  label: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const items = useCallback(
    () =>
      Array.from(
        menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ??
          [],
      ),
    [],
  );

  /** Close, and hand focus back to the trigger so the keyboard is not stranded. */
  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  /**
   * Focus the first item, whether the menu was opened by click or by a key: a
   * menu that opens with focus left on the trigger cannot be walked.
   *
   * It runs from `onPlaced` rather than from an effect on `open`, and both parts
   * of that are load bearing since #1843, when this became a portalled panel.
   *
   * WHEN: an effect on `open` runs while the panel is still being measured and
   * is therefore `visibility: hidden`, and focus does not move into a hidden
   * subtree. The menu opened with focus on the body and could not be walked.
   *
   * `preventScroll`: the panel is already fully on screen, so scrolling to the
   * item achieves nothing, and the scroll it caused fired the listener that
   * dismisses the panel, closing the menu in the frame it opened.
   *
   * Neither is visible to jsdom, which has no layout, does not scroll, and does
   * not gate focus on visibility. Both were found in a browser.
   */
  const focusFirstItem = useCallback(() => {
    items()[0]?.focus({ preventScroll: true });
  }, [items]);

  /** Move focus by `step`, wrapping, so the ends of the list are not dead. */
  function move(step: number) {
    const list = items();
    if (list.length === 0) return;
    const at = list.indexOf(document.activeElement as HTMLElement);
    const next = at === -1 ? 0 : (at + step + list.length) % list.length;
    // Same reason as the open effect above: a scrolling focus dismisses the panel.
    list[next]!.focus({ preventScroll: true });
  }

  return (
    <div ref={wrapRef} className="relative inline-block text-left">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className="pn-nav-item inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-[var(--bg-alt)] hover:text-fg"
      >
        <svg
          aria-hidden="true"
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="currentColor"
        >
          <circle cx="8" cy="3" r="1.5" />
          <circle cx="8" cy="8" r="1.5" />
          <circle cx="8" cy="13" r="1.5" />
        </svg>
      </button>

      <AnchoredPanel
        open={open}
        onClose={() => setOpen(false)}
        triggerRef={triggerRef}
        panelRef={menuRef}
        onPlaced={focusFirstItem}
        align="end"
        role="menu"
        aria-label={label}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            close(true);
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            move(1);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            move(-1);
          } else if (e.key === "Home") {
            e.preventDefault();
            items()[0]?.focus();
          } else if (e.key === "End") {
            e.preventDefault();
            items().at(-1)?.focus();
          } else if (e.key === "Tab") {
            // Tabbing out is a dismissal, but the browser is already moving
            // focus, so this must not drag it back to the trigger.
            close(false);
          }
        }}
        // Sized to its content rather than to a guess: the roster's "View as
        // <full name>" item is as long as the longest name on the roster, and a
        // fixed width made it wrap inside the popup. It keeps the name because
        // that is the identity guarantee (L237); the popup grows instead.
        //
        // #1843: no `absolute`, no offset and no z-index here any more. The
        // panel is portalled and positioned in viewport space by AnchoredPanel,
        // so a position stated here would fight it. The z-index goes with it:
        // in the top level body there is nothing left to stack against.
        className="w-max min-w-44 rounded-md border border-border bg-surface p-1 text-left shadow-pop"
      >
        {children}
      </AnchoredPanel>
    </div>
  );
}
