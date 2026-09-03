// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { DebtTeamLadder } from "@/components/admin/DebtTeamLadder";

// #1796: the Team column printed raw keys as a comma list, wrapped to three lines
// on the widest agent so row heights varied, and threw away the fact that the
// values are a RANK an agent covers a band of.

const rungs = (c: HTMLElement) => Array.from(c.querySelectorAll("[data-rung]"));
const covered = (c: HTMLElement) =>
  rungs(c)
    .filter((r) => r.getAttribute("data-covered") === "true")
    .map((r) => Number(r.getAttribute("data-rung")));

describe("DebtTeamLadder", () => {
  it("always draws five rungs, whatever the agent covers", () => {
    // The row height symptom: the glyph is the same size for everybody, so the
    // cell cannot grow with the number of tiers.
    for (const teams of [[], ["low"], ["low", "medium", "high", "very_high", "ultra_high"]]) {
      const { container, unmount } = render(<DebtTeamLadder teams={teams} />);
      expect(rungs(container)).toHaveLength(5);
      unmount();
    }
  });

  it("fills the rungs the agent covers, and only those", () => {
    const { container } = render(<DebtTeamLadder teams={["medium", "high", "very_high"]} />);
    expect(covered(container)).toEqual([2, 3, 4]);
  });

  it("fills nothing when no team is set", () => {
    const { container } = render(<DebtTeamLadder teams={[]} />);
    expect(covered(container)).toEqual([]);
    expect(screen.getByText("No team set")).toBeTruthy();
  });

  it("names the band in words, using labels rather than stored keys", () => {
    render(<DebtTeamLadder teams={["ultra_high", "very_high", "high", "medium"]} />);
    expect(screen.getByText("Covers Medium to Ultra High")).toBeTruthy();
  });

  it("never shows an underscored key to a reader", () => {
    const { container } = render(
      <DebtTeamLadder teams={["ultra_high", "very_high"]} />,
    );
    expect(container.textContent).not.toMatch(/ultra_high|very_high/);
  });

  it("reads a bare string exactly as it reads a single element array", () => {
    // `debt_team` is an array on most agents and a bare string on a few.
    const a = render(<DebtTeamLadder teams={["high"]} />);
    const first = a.container.textContent;
    a.unmount();
    const b = render(<DebtTeamLadder teams={["high"]} />);
    expect(b.container.textContent).toBe(first);
  });

  it("shows a value that is not on the ladder rather than dropping it", () => {
    // The silent under report this must not do (L113). Shown as STORED, so it
    // reads as a data question rather than a formatting bug.
    render(<DebtTeamLadder teams={["low", "ultra_high_beyond"]} />);
    expect(screen.getByText("ultra_high_beyond")).toBeTruthy();
    // And the band beside it still describes the rung it did match.
    expect(screen.getByText("Covers Low")).toBeTruthy();
  });

  it("does not name an off ladder value twice", () => {
    const { container } = render(<DebtTeamLadder teams={["low", "credit"]} />);
    expect(container.textContent!.match(/credit/g)).toHaveLength(1);
  });

  it("keeps the glyph out of the accessible tree, and the words in it", () => {
    // Colour is never the only signal, and the shape is never the only way to
    // learn what it means.
    const { container } = render(<DebtTeamLadder teams={["high"]} />);
    const glyph = container.querySelector("[data-ladder]")!;
    expect(glyph.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByText("Covers High")).toBeTruthy();
  });

  it("carries the whole sentence for a reader who wants it spelled out", () => {
    // Including anything off the ladder, which the visible band hands to a chip.
    const { container } = render(<DebtTeamLadder teams={["low", "credit"]} />);
    expect(container.querySelector("[data-ladder]")!.getAttribute("title")).toBe(
      "Covers Low, plus credit",
    );
  });

  it("carries the rank in height, not only in colour", () => {
    // An ordered scale expressed only as colour breaks the moment one member is
    // changed for an unrelated reason (L545), and colour may never be the sole
    // signal. Each rung is taller than the one below it.
    const { container } = render(<DebtTeamLadder teams={["low"]} />);
    const heights = rungs(container).map((r) =>
      Number((r as HTMLElement).style.height.replace("%", "")),
    );
    expect(heights).toEqual([...heights].sort((a, b) => a - b));
    expect(new Set(heights).size).toBe(5);
  });
});
