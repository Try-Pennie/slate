// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { MarkedLabel, MARK_OPTICAL_NUDGE_PX } from "@/components/ui/MarkedLabel";

// #2112: the same mark-beside-a-word construction was written by hand in six
// places and each was a pixel out for one cause, so it was reported from
// whichever screen somebody happened to be looking at.
//
// The PIXEL itself cannot be asserted here: jsdom has no layout engine and no font
// metrics, so it can neither measure the offset nor tell whether it is right. What
// this holds is the structure the measurement is applied through, and the
// arithmetic is recorded, with its two controls, in the component's docstring.

const label = (c: HTMLElement) => c.firstElementChild as HTMLElement;
const mark = (c: HTMLElement) => c.querySelector("[data-marked-label-mark]") as HTMLElement;

describe("MarkedLabel (#2112)", () => {
  it("nudges the MARK, not the label, so the words stay where the layout put them", () => {
    const { container } = render(
      <MarkedLabel mark={<span data-dot="" />}>Calendar connected</MarkedLabel>,
    );
    expect(mark(container as unknown as HTMLElement).className).toContain(
      `top-[-${MARK_OPTICAL_NUDGE_PX}px]`,
    );
    // The text is a direct child of the row, carrying no offset of its own. Moving
    // both would align the pair to each other and leave the row riding high.
    expect(label(container as unknown as HTMLElement).textContent).toBe("Calendar connected");
    expect(label(container as unknown as HTMLElement).className).not.toMatch(/top-\[/);
  });

  it("hides the mark from assistive tech, since the word says the same thing", () => {
    const { container } = render(<MarkedLabel mark={<span data-dot="" />}>Editing above</MarkedLabel>);
    expect(mark(container as unknown as HTMLElement).getAttribute("aria-hidden")).toBe("true");
    // Once, here, rather than at each call site: a decorative shape beside a word
    // that already says the same thing is decoration everywhere it appears.
    expect(container.querySelector("[data-dot]")?.getAttribute("aria-hidden")).toBeNull();
  });

  it("leaves the mark's own size and colour to the caller", () => {
    // What the row MEANS is the caller's; this owns only where the mark sits.
    const { container } = render(
      <MarkedLabel mark={<span className="h-1.5 w-1.5 rounded-full bg-pennie-sky" />}>Editing</MarkedLabel>,
    );
    const dot = container.querySelector(".rounded-full") as HTMLElement;
    expect(dot.className).toContain("h-1.5");
    expect(dot.className).toContain("bg-pennie-sky");
  });

  it("takes the row's own classes, so the gap and the type stay at the call site", () => {
    const { container } = render(
      <MarkedLabel className="gap-1.5 text-xs text-fg-muted" mark={<span />}>
        all calendars syncing
      </MarkedLabel>,
    );
    const row = label(container as unknown as HTMLElement);
    expect(row.className).toContain("inline-flex");
    expect(row.className).toContain("items-center");
    expect(row.className).toContain("gap-1.5");
    expect(row.className).toContain("text-xs");
  });
});
