/**
 * Where a floating panel sits relative to the control that opened it (#1843).
 *
 * Pure, and deliberately so. The panels this serves are portalled to the body
 * and positioned `fixed`, which is what stops an ancestor clipping them; that
 * leaves the coordinates to be worked out, and a computation done inline in a
 * component can only be tested in a browser. jsdom has no layout at all, so
 * every rect it reports is zero and no test there could tell a correct flip from
 * a panel drawn off the bottom of the screen.
 *
 * Everything is in VIEWPORT coordinates, which is what `getBoundingClientRect`
 * gives and what `position: fixed` consumes, so nothing here needs to know about
 * scrolling.
 */

export interface Box {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface AnchoredPositionInput {
  /** The trigger, in viewport coordinates. */
  trigger: Box;
  /** How big the panel is. Measured after render, before it is shown. */
  panel: { width: number; height: number };
  viewport: { width: number; height: number };
  /**
   * Which of the trigger's edges the panel lines up with. `end` opens inward
   * from a control at the right of a row, which is where a row action menu
   * lives; `start` suits a field whose panel should sit under its left edge.
   */
  align: "start" | "end";
  /** Space between the trigger and the panel, in px. */
  gap: number;
}

export interface AnchoredPosition {
  top: number;
  left: number;
  placement: "below" | "above";
}

/** Keep `v` inside [0, max], preferring 0 when the panel cannot fit at all. */
function clamp(v: number, size: number, max: number): number {
  if (size >= max) return 0;
  return Math.min(Math.max(v, 0), max - size);
}

export function anchoredPosition(
  input: AnchoredPositionInput,
): AnchoredPosition {
  const { trigger, panel, viewport, align, gap } = input;

  const roomBelow = viewport.height - trigger.bottom - gap;
  const roomAbove = trigger.top - gap;

  // Decided by ROOM, never by which half of the screen the trigger is in. A
  // halfway rule flips a short panel upward for no reason, and the panels here
  // vary from a two item menu to a month of dates.
  const placement: "below" | "above" =
    panel.height <= roomBelow
      ? "below"
      : panel.height <= roomAbove
        ? "above"
        : roomAbove > roomBelow
          ? "above"
          : "below";

  const rawTop =
    placement === "below"
      ? trigger.bottom + gap
      : trigger.top - gap - panel.height;

  // Only the upward case is clamped to the top. Downward overflow is left alone
  // on purpose: a panel taller than the space below it scrolls the page, which is
  // recoverable, whereas a negative top puts its first item permanently out of
  // reach above the window.
  const top = placement === "above" ? Math.max(rawTop, 0) : rawTop;

  const rawLeft = align === "end" ? trigger.right - panel.width : trigger.left;
  const left = clamp(rawLeft, panel.width, viewport.width);

  return { top, left, placement };
}

/**
 * Where a floating panel sits in the stack.
 *
 * ABOVE the sticky app header, which is `z-30`: a panel that flips upward reaches
 * the top of the window, and with an automatic z-index the header simply painted
 * over its first rows. That was found in a browser, on the time off calendar, and
 * it looked like a clipped panel rather than a stacking one.
 *
 * BELOW the skip link, which is `z-60`: that control has to stay reachable over
 * everything, and the comment on it in globals.css says so.
 *
 * `scripts/test-anchored-panel-stacking.ts` reads both of those numbers out of
 * the source rather than trusting this comment, so the three cannot drift.
 */
export const ANCHORED_PANEL_Z = 50;
