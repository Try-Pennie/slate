// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { DebtTeamLedger } from "@/components/admin/DebtTeamLedger";

// #1812, Dan on the glyph that shipped in #1796: "I hate the change made to the
// teams."
//
// Three things were wrong, and the first came from the spec rather than the
// build: the marks sat next to a sentence saying the same thing, so every row
// said it twice and the bars were noise. The rungs also rose left to right while
// most of the roster covers Low only, so the commonest row drew the faintest
// mark. And per row bars share no axis, so nothing could be compared down the
// column, which was the whole argument for drawing it.
//
// Ledger letters instead: five in fixed positions, their own legend, aligned down
// every row, and no sentence beside them.

const letters = (c: HTMLElement) => Array.from(c.querySelectorAll("[data-rung]"));
const covered = (c: HTMLElement) =>
  letters(c)
    .filter((l) => l.getAttribute("data-covered") === "true")
    .map((l) => l.textContent);

describe("DebtTeamLedger", () => {
  it("draws five letters in fixed positions, whatever the agent covers", () => {
    for (const teams of [[], ["low"], ["low", "medium", "high", "very_high", "ultra_high"]]) {
      const { container, unmount } = render(<DebtTeamLedger teams={teams} />);
      expect(letters(container)).toHaveLength(5);
      unmount();
    }
  });

  it("reads L M H V U across, in rung order", () => {
    const { container } = render(<DebtTeamLedger teams={["low", "medium", "high", "very_high", "ultra_high"]} />);
    expect(letters(container).map((l) => l.textContent)).toEqual(["L", "M", "H", "V", "U"]);
  });

  it("marks only the covered rungs", () => {
    const { container } = render(<DebtTeamLedger teams={["medium", "high", "very_high"]} />);
    expect(covered(container)).toEqual(["M", "H", "V"]);
  });

  it("keeps the uncovered rungs in place as position markers", () => {
    // They are load bearing: they say WHICH position is which, so a reader can
    // tell "l M H V u" from "L M H v u" without counting.
    const { container } = render(<DebtTeamLedger teams={["medium"]} />);
    expect(letters(container).map((l) => l.textContent)).toEqual(["l", "M", "h", "v", "u"]);
  });

  it("distinguishes covered from uncovered by weight AND tone, not colour alone", () => {
    const { container } = render(<DebtTeamLedger teams={["low"]} />);
    const [on, off] = letters(container) as HTMLElement[];
    expect(on.className).toContain("font-semibold");
    expect(on.className).toContain("var(--ledger-on)");
    expect(off!.className).toContain("font-normal");
    expect(off!.className).toContain("var(--ledger-off)");
  });

  it("gives every letter the same width, so the columns line up down the table", () => {
    // The vertical comparison is the entire point, and letters are not equal
    // width in a proportional face. jsdom cannot compute Tailwind, so the class
    // is the evidence available here; the rendered alignment is checked in a
    // browser instead.
    const { container } = render(<DebtTeamLedger teams={["low", "ultra_high"]} />);
    for (const l of letters(container)) {
      expect(l.className).toMatch(/\bw-3\b/);
      expect(l.className).toMatch(/text-center/);
    }
  });

  it("says nothing in letters and everything in words", () => {
    // "L M H V U" read aloud is useless.
    const { container } = render(<DebtTeamLedger teams={["medium", "high", "very_high"]} />);
    const glyph = container.querySelector("[data-ledger]")!;
    expect(glyph.getAttribute("role")).toBe("img");
    expect(glyph.getAttribute("aria-label")).toBe("Covers Medium to Very High");
    // The label lives on the glyph, so the glyph itself must NOT be hidden, or
    // the name goes with it. The letters inside are.
    expect(glyph.getAttribute("aria-hidden")).toBeNull();
    for (const l of letters(container)) expect(l.getAttribute("aria-hidden")).toBe("true");
  });

  it("names a gap as a list rather than as a range", () => {
    const { container } = render(<DebtTeamLedger teams={["low", "high", "ultra_high"]} />);
    expect(container.querySelector("[data-ledger]")!.getAttribute("aria-label")).toBe(
      "Covers Low, High, Ultra High",
    );
  });

  it("says so when no team is set", () => {
    const { container } = render(<DebtTeamLedger teams={[]} />);
    expect(container.querySelector("[data-ledger]")!.getAttribute("aria-label")).toBe("No team set");
    expect(covered(container)).toEqual([]);
  });

  it("never prints the word Covers where a reader can see it", () => {
    // It repeated down the left edge of the column, which is the edge you scan,
    // spending it on a word that never varies.
    const { container } = render(<DebtTeamLedger teams={["low", "medium"]} />);
    expect(container.textContent).not.toMatch(/Covers/);
    expect(container.textContent).not.toMatch(/Low|Medium|High/);
  });

  it("shows a value outside the ladder rather than dropping it", () => {
    // Carried over from #1796 and the constraint most likely to be lost in a
    // rewrite: five letters have no position for `ultra_high_beyond`, and the
    // tempting implementation silently under reports that agent (L113).
    render(<DebtTeamLedger teams={["low", "ultra_high_beyond"]} />);
    expect(screen.getByText("ultra_high_beyond")).toBeTruthy();
  });

  it("keeps an off ladder value in the spoken label too", () => {
    const { container } = render(<DebtTeamLedger teams={["low", "credit"]} />);
    expect(container.querySelector("[data-ledger]")!.getAttribute("aria-label")).toBe(
      "Covers Low, plus credit",
    );
  });

  it("reads a bare string the same as a single element array", () => {
    const a = render(<DebtTeamLedger teams={["high"]} />);
    const first = a.container.innerHTML;
    a.unmount();
    expect(render(<DebtTeamLedger teams={["high"]} />).container.innerHTML).toBe(first);
  });
});
