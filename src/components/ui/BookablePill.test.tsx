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

  // #3030, Dan 2026-10-02: an advisor the Twilio sync holds back on Redistribute
  // read the same "No" as one who genuinely is not bookable, and the two mean
  // different things to a manager. Settled in a design round: the WORD differs
  // and the ring is DASHED, on the same outline, so colour is never the signal.
  describe("an advisor Twilio holds back on Redistribute", () => {
    it("reads Redistribute in place of the negative word, in every wording", () => {
      const said = (wording: "short" | "full" | "self") => {
        const r = render(<BookablePill bookable={false} heldByTwilio wording={wording} />);
        const text = r.container.textContent;
        r.unmount();
        return text;
      };
      expect(said("short")).toBe("Redistribute");
      expect(said("full")).toBe("Redistribute");
      // The reader IS the advisor there, so it says where they are rather than
      // naming a tag at them.
      expect(said("self")).toBe("On Redistribute");
    });

    it("draws a DASHED ring, a third shape, in the same muted tone and weight", () => {
      const held = render(<BookablePill bookable={false} heldByTwilio wording="short" />);
      const m = mark(held.container as unknown as HTMLElement);
      expect(m.getAttribute("data-bookable-mark")).toBe("dashed");
      expect(m.className).toContain("border-dashed");
      expect(m.className).toContain("border-[1.5px]");
      expect(m.className).toContain("border-[var(--fg-muted)]");
      expect(m.getAttribute("aria-hidden")).toBe("true");
      held.unmount();

      // The plain negative keeps its SOLID ring, or the shape says nothing.
      const no = render(<BookablePill bookable={false} wording="short" />);
      expect(mark(no.container as unknown as HTMLElement).className).not.toContain("border-dashed");
    });

    it("keeps the neutral outline treatment of No, never an error", () => {
      const variantOf = (heldByTwilio: boolean) => {
        const r = render(<BookablePill bookable={false} heldByTwilio={heldByTwilio} wording="short" />);
        const cls = pill(r.container as unknown as HTMLElement).className;
        r.unmount();
        return cls;
      };
      expect(variantOf(true)).toBe(variantOf(false));
      expect(variantOf(true)).not.toMatch(/error|rose/);
    });

    it("never shows on a bookable advisor, whatever the flag says", () => {
      // Taking somebody OUT of the pool is never held back, so a bookable row
      // carrying the tag is just bookable until the sync acts.
      const { container } = render(<BookablePill bookable heldByTwilio wording="short" />);
      expect(container.textContent).toBe("Yes");
      expect(mark(container as unknown as HTMLElement).getAttribute("data-bookable-mark")).toBe("filled");
    });
  });
});
