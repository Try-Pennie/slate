// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { useRef } from "react";
import { render } from "@testing-library/react";
import { AnchoredPanel } from "@/components/ui/AnchoredPanel";
import { ANCHORED_PANEL_Z } from "@/components/ui/anchored-position";

// #2046: a panel opened from INSIDE another panel has to paint above it.
//
// Both panels portal to `document.body` and both took the same fixed z-index, so
// which one won was decided by DOM order. React commits a child portal before its
// parent's, so the NESTED panel is always appended first and is always the one
// underneath: the time list inside the time off calendar drew behind the calendar
// and behind its Cancel and Confirm row, which covered the option somebody was
// reaching for and hid the focus ring with it (WCAG 2.4.11).
//
// jsdom has no layout and no paint order, so the assertion is on the LEVEL each
// panel is given, which is the thing that decides it, rather than on visibility
// (which jsdom would report the same either way).

function Nested({ inner }: { inner: boolean }) {
  const outerTrigger = useRef<HTMLButtonElement>(null);
  const innerTrigger = useRef<HTMLButtonElement>(null);
  return (
    <div>
      <button ref={outerTrigger}>outer</button>
      <AnchoredPanel open onDismiss={() => {}} triggerRef={outerTrigger} aria-label="outer">
        <>
          <button ref={innerTrigger}>inner</button>
          {inner ? (
            <AnchoredPanel open onDismiss={() => {}} triggerRef={innerTrigger} aria-label="inner">
              <span>inner contents</span>
            </AnchoredPanel>
          ) : null}
        </>
      </AnchoredPanel>
    </div>
  );
}

const panelBy = (label: string) =>
  document.querySelector(`[data-anchored-panel][aria-label="${label}"]`) as HTMLElement;

/**
 * The level a panel is painted on, or a refusal.
 *
 * It REFUSES an unreadable one rather than answering a number (L50). An absent
 * inline z-index reads as `Number("") === 0`, which is a perfectly comparable
 * value, so the two assertions here that compare one panel against another would
 * hold between two panels that were never measured at all and report a pass. The
 * throw is the fail-safe side: in a test, learning nothing has to be a failure.
 */
const zOf = (label: string): number => {
  const raw = panelBy(label).style.zIndex;
  const n = Number(raw);
  if (raw === "" || !Number.isFinite(n)) {
    throw new Error(`panel "${label}" has no readable z-index (got ${JSON.stringify(raw)})`);
  }
  return n;
};

describe("AnchoredPanel stacking between panels (#2046)", () => {
  it("puts a nested panel ABOVE the panel that contains it", () => {
    render(<Nested inner />);
    expect(zOf("inner")).toBeGreaterThan(zOf("outer"));
  });

  it("leaves a panel that is not nested on the base level", () => {
    render(<Nested inner={false} />);
    expect(zOf("outer")).toBe(ANCHORED_PANEL_Z);
  });

  it("orders by NESTING and not by the order the panels reached the body", () => {
    // The heart of it. Both panels are children of `document.body`, and the inner
    // one is appended FIRST, so a reader comparing DOM position would conclude the
    // opposite of what has to be true. Assert the two facts together, so this
    // cannot pass by the levels happening to agree with an order that is wrong.
    render(<Nested inner />);
    const kids = [...document.body.querySelectorAll("[data-anchored-panel]")];
    const innerAt = kids.indexOf(panelBy("inner"));
    const outerAt = kids.indexOf(panelBy("outer"));
    expect(innerAt, "the nested panel really does reach the body first").toBeLessThan(outerAt);
    expect(zOf("inner"), "and is still given the higher level").toBeGreaterThan(zOf("outer"));
  });

  it("gives two panels at the same nesting depth the same level", () => {
    // Siblings are not a tie that matters: neither is inside the other, they never
    // overlap, and DOM order is a fine answer for them.
    const Two = () => {
      const a = useRef<HTMLButtonElement>(null);
      const b = useRef<HTMLButtonElement>(null);
      return (
        <div>
          <button ref={a}>a</button>
          <button ref={b}>b</button>
          <AnchoredPanel open onDismiss={() => {}} triggerRef={a} aria-label="a">
            <span>a</span>
          </AnchoredPanel>
          <AnchoredPanel open onDismiss={() => {}} triggerRef={b} aria-label="b">
            <span>b</span>
          </AnchoredPanel>
        </div>
      );
    };
    render(<Two />);
    expect(zOf("a")).toBe(zOf("b"));
    expect(zOf("a")).toBe(ANCHORED_PANEL_Z);
  });
});
