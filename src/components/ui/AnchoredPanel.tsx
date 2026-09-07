"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  anchoredPosition,
  anchoredPanelZ,
  triggerIsOnScreen,
} from "@/components/ui/anchored-position";

/**
 * How many panels deep this subtree is (#2046).
 *
 * A panel opened from inside another panel must paint above it, and NOTHING in
 * the DOM says which of two panels contains the other: both portal to
 * `document.body`, so they are siblings there whatever their nesting. With one
 * shared z-index the winner was decided by document order, and that order is the
 * WRONG WAY ROUND: React commits a child portal before its parent's, so the
 * nested panel is appended first and painted underneath. Measured on the time
 * off form, where the time list sat at body index 10 and the calendar containing
 * it at 11.
 *
 * Context is what still knows the nesting, because it follows the REACT tree
 * rather than the DOM and passes through a portal unchanged. So a panel reads
 * the depth it was rendered at and publishes one more to whatever it contains.
 */
const PanelDepth = createContext(0);

/** A subscription that never fires: the hydration probe only needs the snapshots. */
const subscribeNothing = () => () => {};

/**
 * A panel that opens from a control and cannot be clipped by anything (#1843).
 *
 * WHY IT IS NOT `absolute`. Four popups in this app were an `absolute` div
 * inside whatever container happened to hold the trigger. On the agent roster
 * that container is the table's `overflow-x-auto` wrapper, which clipped the row
 * menu: the items on the last rows of a 117 agent table were cut off, and "View
 * as" is the control that changes who you are signed in as, so a half hidden
 * item is a mis-click rather than an eyesore. The clipping also hid the focus
 * ring, which is WCAG 2.4.11 (focus not obscured), not a polish issue.
 *
 * The vertical clipping from a rule that names the horizontal axis is the part
 * worth knowing: CSS does not allow one axis to scroll while the other stays
 * visible, so setting either to anything but `visible` computes the other to
 * `auto`. `overflow-x-auto` clips the bottom too.
 *
 * WHY BOTH A PORTAL AND `fixed`, when either alone looks sufficient. `fixed`
 * escapes an `overflow` ancestor on its own, but NOT an ancestor carrying
 * `transform`, `filter`, `perspective`, `will-change` or `contain`: any of those
 * makes it the containing block and the clipping is back. This app animates with
 * transforms (the `.pn-*` keyframes), so relying on `fixed` alone would work
 * until somebody animated an ancestor, and would fail as a mysterious
 * half-drawn menu rather than as anything a test would name. The portal removes
 * the ancestor chain entirely; `fixed` is then what keeps the coordinates in
 * viewport space.
 *
 * IT FOLLOWS THE TRIGGER ON SCROLL, and closes only once the trigger has left
 * the viewport (#2052).
 *
 * This reverses what #1843 decided, so the old reasoning is kept rather than
 * quietly replaced: a fixed panel does not move with the row it belongs to, and
 * a menu hovering beside an unrelated row is worse than one that has gone. That
 * is true, and it was argued from the roster's row menu. It was wrong for a
 * picker somebody is filling IN. Scrolling to see the field being edited, or an
 * inertial flick on a trackpad, shut the calendar mid pick, and #2048 is what
 * that cost when the same path also threw the value away.
 *
 * Repositioning serves both, because the original concern reduces to a trigger
 * that is no longer on screen, which is now the only thing that dismisses. The
 * work is one rect read and two style writes, coalesced onto an animation frame
 * so a scroll cannot queue more than one.
 *
 * WHERE it goes is `anchored-position.ts`, which is pure and node tested at sizes
 * jsdom cannot produce, since jsdom has no layout and reports every rect as zero.
 */
export function AnchoredPanel({
  open,
  onDismiss,
  triggerRef,
  align = "end",
  gap = 4,
  className,
  children,
  panelRef: externalRef,
  onPlaced,
  keepMounted = false,
  ...aria
}: {
  open: boolean;
  /**
   * Called when the panel is DISMISSED: an outside mousedown, or the page
   * scrolling underneath it. Both are incidental gestures aimed at something
   * else on the page, not decisions about the panel's contents.
   *
   * IT IS NOT A CANCEL, and the name says so because the old one (`onClose`) did
   * not, and cost somebody their typed input (#2048). The time off form wired
   * this to a handler that restored the values held before the panel opened, so a
   * click aimed anywhere else on the page, or a scroll, silently erased a date
   * that had just been picked, with no undo and nothing said.
   *
   * A panel whose contents can be abandoned owes the reader an explicit Cancel
   * and Escape for that, and must close on a dismissal keeping whatever is in it
   * (L628).
   */
  onDismiss: () => void;
  triggerRef: RefObject<HTMLElement | null>;
  /**
   * The positioned element itself. The panel IS the menu or dialog rather than a
   * wrapper around one, so the caller puts `role` and the aria on it and needs a
   * handle to query its own items; a second nested div would be one element that
   * carries the semantics and another that carries the position, which is two
   * places to keep in step for no gain.
   */
  panelRef?: RefObject<HTMLDivElement | null>;
  /**
   * Called once the panel has been measured and placed, which is the first
   * moment anything inside it can take focus.
   *
   * This is not a convenience. Until it is placed the panel is
   * `visibility: hidden`, so it is not painted at 0,0 while being measured, and
   * an element inside a hidden subtree CANNOT RECEIVE FOCUS: `focus()` returns
   * silently and the active element stays where it was. A consumer that focused
   * its first item from an ordinary effect ran in exactly that window, because
   * React flushes a render's passive effects before the re-render that the
   * measuring layout effect schedules. The menu then opened with focus still on
   * the page body and could not be walked with the keyboard at all, which is the
   * whole reason it is a menu. jsdom cannot see any of this (it has no layout and
   * does not gate focus on visibility), so it was found in a browser and this
   * callback is what makes the ordering explicit rather than incidental.
   */
  onPlaced?: () => void;
  /**
   * Keep the element in the DOM while closed, hidden with the `hidden`
   * attribute rather than unmounted.
   *
   * The combobox pattern needs this: `aria-controls` on the input must name a
   * real element even when the list is shut, and an id pointing at nothing is
   * not a weaker version of that, it is an invalid reference. Only the caller
   * knows whether its panel is under that contract, so it is a prop rather than
   * this component guessing.
   */
  keepMounted?: boolean;
  align?: "start" | "end";
  gap?: number;
  className?: string;
  children: ReactNode;
  id?: string;
  role?: string;
  "aria-label"?: string;
  "aria-modal"?: boolean;
  onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
}) {
  const depth = useContext(PanelDepth);
  const panelRef = useRef<HTMLDivElement>(null);
  // One callback ref writing both handles, rather than picking between two ref
  // objects at render time: a conditional ref is a different object on the
  // renders where the caller's own ref changes, which defeats the memoisation
  // every effect below depends on.
  const setRefs = useCallback(
    (el: HTMLDivElement | null) => {
      panelRef.current = el;
      if (externalRef) externalRef.current = el;
    },
    [externalRef],
  );

  /**
   * Whether the client has taken over. A portal needs a DOM, and `keepMounted`
   * renders while closed, so this cannot simply test for `document`: doing that
   * would render nothing on the server and the panel on the client's first pass,
   * which is a hydration mismatch. This is the standard hydration probe, and it
   * is used rather than a `setState` in an effect because that schedules a
   * render from inside an effect for a value nothing else reads.
   */
  const mounted = useSyncExternalStore(
    subscribeNothing,
    () => true,
    () => false,
  );

  /**
   * Measure and place, by writing the style directly rather than through state.
   *
   * Deliberately imperative. Measuring into state means the layout effect sets
   * state, which schedules a second render before paint: a cascading render that
   * eslint correctly refuses, for a value no other part of the tree reads. A
   * direct write is one pass, and it makes "placed" an exact moment rather than
   * a render we hope has happened, which is what `onPlaced` depends on.
   */
  const place = useCallback(() => {
    const t = triggerRef.current;
    const el = panelRef.current;
    if (!t || !el) return false;
    const r = t.getBoundingClientRect();
    const pos = anchoredPosition({
      trigger: {
        top: r.top,
        left: r.left,
        right: r.right,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
      },
      panel: { width: el.offsetWidth, height: el.offsetHeight },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      align,
      gap,
    });
    el.style.top = `${pos.top}px`;
    el.style.left = `${pos.left}px`;
    el.style.visibility = "visible";
    el.dataset.placement = pos.placement;
    return true;
  }, [triggerRef, align, gap]);

  // Before paint, so the panel is never seen at the wrong place first, and
  // `onPlaced` only fires once it is genuinely visible: nothing inside a hidden
  // subtree can take focus.
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!open) {
      if (el) el.style.visibility = "hidden";
      return;
    }
    if (place()) onPlaced?.();
  }, [open, place, onPlaced]);

  useEffect(() => {
    if (!open) return;
    let frame = 0;
    const onScroll = (e: Event) => {
      // A scroll INSIDE the panel is the person reading a long list, not the page
      // moving underneath it, so it must not move or dismiss anything. The target
      // of a window or document scroll is not a Node, and `contains` THROWS on
      // one rather than answering false, so the type check is required rather
      // than defensive.
      const t = e.target;
      if (t instanceof Node && panelRef.current?.contains(t)) return;
      // Coalesced onto one animation frame: a scroll fires far faster than the
      // page paints, and every call here reads a rect, which forces layout.
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const trigger = triggerRef.current;
        if (!trigger) return;
        const r = trigger.getBoundingClientRect();
        if (!triggerIsOnScreen(r, { width: window.innerWidth, height: window.innerHeight })) {
          onDismiss();
          return;
        }
        place();
      });
    };
    const onResize = () => place();
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      onDismiss();
    };
    // `true` so a scroll inside the table's own scroll container is caught too;
    // a scroll event on an element does not bubble.
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    document.addEventListener("mousedown", onDown);
    return () => {
      // The pending frame is cancelled, or a panel closed mid scroll would place
      // itself once more after it had gone.
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open, onDismiss, place, triggerRef]);

  // The portal itself needs a DOM, so nothing renders until mount either way.
  if (!mounted) return null;
  if (!open && !keepMounted) return null;

  return createPortal(
    <div
      {...aria}
      ref={setRefs}
      data-anchored-panel=""
      hidden={!open}
      // Starts hidden at 0,0 and is placed by the layout effect before paint, so
      // it is never seen in the corner. `onPlaced` is the moment it becomes
      // visible, and therefore the first moment anything in it can take focus.
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        visibility: "hidden",
        zIndex: anchoredPanelZ(depth),
      }}
      className={className}
    >
      <PanelDepth.Provider value={depth + 1}>{children}</PanelDepth.Provider>
    </div>,
    document.body,
  );
}
