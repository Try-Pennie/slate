"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * The marker that says you are acting as somebody else (#2037).
 *
 * WHY IT IS NOT A COLOURED BAR. This state was drawn in Slate's ordinary palette,
 * a navy bar with a sky button, so the one surface saying "every action you take
 * now happens as someone else" looked like a piece of normal chrome. Dan: "it
 * should be jarring and obvious. Not anything that exists somewhere else in
 * slate."
 *
 * Making it red was already taken, in the same slot: the calendar-not-syncing bar
 * sits directly below this one and is rose. Two red bars stacked would have made
 * the more serious of the two look like the routine one.
 *
 * So the treatment is a hazard striped FRAME around the whole viewport whose top
 * edge carries the label, settled over four design rounds and recorded in full at
 * `docs/design/impersonation-marker.html`, with DESIGN.md's Hazard Rule naming it
 * as the one functional use of yellow in the product. Read the record before
 * changing any of this: every number in it is measured, and the reason the rules
 * permit it is written out there rather than being obvious from the code.
 *
 * THE STRIPES CARRY TWO COLOURS ON PURPOSE. A frame is one half of a pair with
 * the page behind it, and Slate has two pages. Navy alone measures 14.85:1 on the
 * beige page and 1.23:1 on the dark one; mustard alone is 13.57:1 on dark and
 * 1.34:1 on beige. Either one vanishes in one theme while measuring beautifully
 * in the other, so the stripe carries both and one half always holds the edge.
 * That is also why there is no per theme override here: the same paint serves
 * both, which is the whole point of it.
 */
export function ImpersonationFrame({
  name,
  email,
  role,
  children,
}: {
  name: string | null;
  email?: string;
  role: string;
  /** The way out. Rendered by the caller, since it is a server action's form. */
  children: ReactNode;
}) {
  const stripRef = useRef<HTMLDivElement>(null);

  /**
   * Publish what the strip MEASURED, and mark the mode on the root (IM6).
   *
   * The height is not a constant and must never be written as one: it is 30px on
   * one line, 43px on two and 77px on a narrow phone, and those are the record's
   * numbers for the record's own type, not the app's. The page insets itself by
   * this value, so the strip is the only thing that decides it and nothing else
   * names it.
   *
   * A ResizeObserver rather than a one-off read, because the height changes with
   * the window: the sentence goes to two lines below 762px and the identity
   * clause starts wrapping inside itself below 512px. A value measured once would
   * be right until somebody resized, and wrong silently after that.
   */
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const root = document.documentElement;
    const publish = () => {
      root.style.setProperty("--impersonation-strip-h", `${el.offsetHeight}px`);
    };
    root.dataset.impersonating = "on";
    publish();
    // jsdom has no layout and no ResizeObserver; the mode and the initial publish
    // above are what its tests can see, and the browser is where the measuring is
    // verified.
    const RO = typeof ResizeObserver === "undefined" ? null : ResizeObserver;
    const ro = RO ? new RO(publish) : null;
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      delete root.dataset.impersonating;
      root.style.removeProperty("--impersonation-strip-h");
    };
  }, []);

  const who = name ?? email ?? "someone else";

  return (
    <div data-impersonation-frame="" aria-hidden={false}>
      {/* The three painted edges. The TOP edge is the strip below, which is the
          whole idea: the label is IN the frame rather than beside it (IM1). They
          take no pointer events, so a control at the very edge of the page is
          still clickable through them. */}
      <div data-impersonation-edge="left" className="pn-impersonation-edge pn-impersonation-edge--left" />
      <div data-impersonation-edge="right" className="pn-impersonation-edge pn-impersonation-edge--right" />
      <div data-impersonation-edge="bottom" className="pn-impersonation-edge pn-impersonation-edge--bottom" />

      <div
        ref={stripRef}
        data-impersonation-strip=""
        className="pn-impersonation-strip"
        role="status"
      >
        <span aria-hidden="true" className="pn-impersonation-glyph">
          !
        </span>
        {/* IM4: two elements, so a line break can land only BETWEEN them, which is
            the period. Dan: "split it better. At the period." As one string the
            break went wherever the width ran out, which read as a broken marker
            rather than as a sentence. */}
        <span className="pn-impersonation-say">
          <span data-impersonation-clause="identity">
            Viewing as <strong>{who}</strong> ({role}).
          </span>{" "}
          <span data-impersonation-clause="consequence">
            Anything you do here is recorded as them.
          </span>
        </span>
        {children}
      </div>
    </div>
  );
}
