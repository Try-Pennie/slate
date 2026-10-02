// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { BookablePill } from "@/components/ui/BookablePill";

// #1823, Dan on the roster's Bookable column: "The word is redundant. the
// unbookable ones just get a line so we should have a symbol there two with the
// green."
//
// Three problems. The column was headed "Bookable" and every bookable row said
// "Bookable", which is one fact stated twice. The negative state got a hyphen
// rather than a mark, so the two states were not comparable treatments: one a
// pill, the other a placeholder. And the agent detail page already had a
// treatment for the same fact, so the roster was the outlier.

const pill = (c: HTMLElement) => c.querySelector("span.rounded-pill") as HTMLElement;
const mark = (c: HTMLElement) => c.querySelector("[data-bookable-mark]") as HTMLElement;

describe("BookablePill", () => {
  it("says Yes and No where a column header already asks the question", () => {
    const yes = render(<BookablePill bookable wording="short" />);
    expect(yes.container.textContent).toBe("Yes");
    yes.unmount();
    const no = render(<BookablePill bookable={false} wording="short" />);
    expect(no.container.textContent).toBe("No");
  });

  it("says it in full where nothing else does", () => {
    // The agent detail page has no column header, so the pill carries the noun.
    const yes = render(<BookablePill bookable wording="full" />);
    expect(yes.container.textContent).toBe("Bookable");
    yes.unmount();
    const no = render(<BookablePill bookable={false} wording="full" />);
    expect(no.container.textContent).toBe("Not bookable");
  });

  it("keeps the agent's own page optimistic", () => {
    // The reader IS the agent there, and it is a state they are working towards.
    const no = render(<BookablePill bookable={false} wording="self" />);
    expect(no.container.textContent).toBe("Not bookable yet");
    no.unmount();
    expect(render(<BookablePill bookable wording="self" />).container.textContent).toBe("Bookable");
  });

  it("never repeats the column header in the value", () => {
    const { container } = render(<BookablePill bookable wording="short" />);
    expect(container.textContent).not.toMatch(/bookable/i);
  });

  it("draws a pill for BOTH states, so neither reads as an absence", () => {
    for (const bookable of [true, false]) {
      const { container, unmount } = render(<BookablePill bookable={bookable} wording="short" />);
      expect(pill(container as unknown as HTMLElement)).toBeTruthy();
      expect(container.textContent).not.toMatch(/^-$/);
      unmount();
    }
  });

  it("gives both states a mark, and the two differ by more than colour", () => {
    // Colour is never the only signal. One is a filled disc, the other a ring, so
    // the shapes differ as well as the tone.
    const yes = render(<BookablePill bookable wording="short" />);
    const yesMark = mark(yes.container as unknown as HTMLElement);
    expect(yesMark).toBeTruthy();
    expect(yesMark.getAttribute("data-bookable-mark")).toBe("filled");
    yes.unmount();

    const no = render(<BookablePill bookable={false} wording="short" />);
    const noMark = mark(no.container as unknown as HTMLElement);
    expect(noMark).toBeTruthy();
    expect(noMark.getAttribute("data-bookable-mark")).toBe("hollow");
  });

  it("colours the filled mark with the one green legible as a bare mark", () => {
    const { container } = render(<BookablePill bookable wording="short" />);
    expect(mark(container as unknown as HTMLElement).className).toContain("--pennie-green-mark");
  });

  it("treats No as neutral, never as an error", () => {
    // Most of the roster is not bookable today, so a rose treatment would put
    // thirty four rows of alarm on a screen where nothing is wrong.
    const { container } = render(<BookablePill bookable={false} wording="short" />);
    const cls = pill(container as unknown as HTMLElement).className;
    expect(cls).not.toMatch(/error/);
    expect(cls).not.toMatch(/rose/);
    expect(mark(container as unknown as HTMLElement).className).not.toMatch(/error|rose/);
  });

  it("hides the mark from assistive tech, since the word carries the meaning", () => {
    const { container } = render(<BookablePill bookable wording="short" />);
    expect(mark(container as unknown as HTMLElement).getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByText("Yes")).toBeTruthy();
  });

  it("passes alignToColumn through, so a table cell can line it up", () => {
    // The same 9px as every other pill (#3031): the mark is the pill's content
    // and starts on the column edge, so the bubble overhangs no further than the
    // Role pill beside it. The reasoning lives in Pill.test.tsx.
    const { container } = render(<BookablePill bookable wording="short" alignToColumn />);
    expect(pill(container as unknown as HTMLElement).className).toMatch(/-ml-\[9px\]/);
    expect(pill(container as unknown as HTMLElement).className).not.toMatch(/-ml-\[21px\]/);
  });

  it("resolves the two states to the same variants whichever wording is used", () => {
    // This is what stops the roster and the detail page drifting: the VARIANT is
    // one decision and only the words differ.
    const variantOf = (bookable: boolean, wording: "short" | "full" | "self") => {
      const r = render(<BookablePill bookable={bookable} wording={wording} />);
      const cls = pill(r.container as unknown as HTMLElement).className;
      r.unmount();
      return cls.replace(/-ml-\[9px\]\s*/, "");
    };
    for (const w of ["full", "self"] as const) {
      expect(variantOf(true, "short"), `bookable, ${w}`).toBe(variantOf(true, w));
      expect(variantOf(false, "short"), `not bookable, ${w}`).toBe(variantOf(false, w));
    }
    // And the two states really are different, or the assertion above is empty.
    expect(variantOf(true, "short")).not.toBe(variantOf(false, "short"));
  });
});
