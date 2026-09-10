// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AvailabilityGridTable } from "./AvailabilityGridTable";
import { CELL_TREATMENTS, cellTitle } from "@/lib/admin/availability-grid-copy";
import type { AvailabilityGrid, GridCell } from "@/lib/admin/availability-grid";

// The grid's visible content is ONE LETTER per cell (#1302), so the sentence
// behind the letter is the content, and it is all a screen reader gets. A static
// check on the copy builder cannot prove that sentence reaches the screen, and a
// grid whose letters were right while its sentences were stale or missing would
// read as a working screen to everybody who can see colour and as nothing at all
// to everybody who cannot.

const grid = (cells: GridCell[]): AvailabilityGrid => ({
  hours: [9],
  measurable: cells.every((c) => c.kind !== "unknown"),
  days: cells.map((cell, i) => ({
    iso: `2026-08-${String(24 + i).padStart(2, "0")}`,
    weekday: ((i + 1) % 7) + 1,
    cells: [cell],
  })),
});

// Every state, and it really is every state now (#1928). It was named ALL_STATES
// while missing `unknown`, and nothing noticed because the key used to render all
// seven treatments whatever the grid held: the count matched the treatments list
// rather than the data. Deriving the key from what is present is what surfaced it.
const ALL_STATES: GridCell[] = [
  { kind: "open", agents: 3, buckets: 42 },
  { kind: "booked", agents: 3 },
  { kind: "unrostered" },
  { kind: "away", away: 4 },
  { kind: "beyond-horizon", agents: 2 },
  { kind: "closed", note: "Christmas Day" },
  { kind: "unknown" },
];

describe("AvailabilityGridTable (#1302)", () => {
  it("says what every cell means, in the words the builder produces", () => {
    render(<AvailabilityGridTable grid={grid(ALL_STATES)} />);

    // The exact builder output, on screen. Anything less would let the component
    // drift back to holding its own sentence while the builder read fine (L41).
    expect(screen.getByText(cellTitle(ALL_STATES[0], "Monday, August 24", 9))).toBeTruthy();
    expect(screen.getByText(cellTitle(ALL_STATES[2], "Wednesday, August 26", 9))).toBeTruthy();
    expect(screen.getByText(cellTitle(ALL_STATES[4], "Friday, August 28", 9))).toBeTruthy();
  });

  it("carries a letter as well as a colour, for every state that is not an absence", () => {
    render(<AvailabilityGridTable grid={grid(ALL_STATES)} />);
    const cells = document.querySelectorAll("td > span");

    // Colour is never the sole signal. Closed is the one exception and it is an
    // absence rather than a state, so it is deliberately blank.
    for (const [i, state] of ALL_STATES.entries()) {
      const mark = CELL_TREATMENTS.find((t) => t.kind === state.kind)?.mark ?? "";
      expect(cells[i].textContent?.startsWith(mark)).toBe(true);
      if (state.kind !== "closed") expect(mark.length).toBe(1);
    }
  });

  it("explains every state it renders, so no letter is unexplained", () => {
    render(<AvailabilityGridTable grid={grid(ALL_STATES)} />);
    const legend = document.querySelectorAll("ul > li");

    expect(legend.length).toBe(CELL_TREATMENTS.length);
    for (const t of CELL_TREATMENTS) {
      expect(screen.getByText(t.label)).toBeTruthy();
      expect(screen.getByText(t.meaning, { exact: false })).toBeTruthy();
    }
  });

  // #1928: Dan, "what if we only show the values that matter? Like nothing right
  // now is ? or A so we don't need to show those at all."
  it("leaves out a state the grid does not hold, from the key AND the counts", () => {
    render(
      <AvailabilityGridTable
        grid={grid([
          { kind: "open", agents: 3, buckets: 42 },
          { kind: "closed", note: "Christmas Day" },
        ])}
      />,
    );
    const labels = [...document.querySelectorAll("ul > li")].map(
      (li) => li.querySelector("span:nth-child(2)")?.textContent ?? "",
    );
    expect(labels).toEqual(["Bookable", "Closed"]);
    // And the counts strip above it says nothing about them either, since the
    // two are one list now.
    const strip = document.querySelector("div.mb-4")?.textContent ?? "";
    expect(strip).not.toMatch(/away|rostered|horizon|could not be checked/i);
    expect(strip).toMatch(/bookable hours/);
  });

  // The state that used to be missing from the counts strip whatever its count,
  // which is the could-not-measure one: a grid whose hours could not be read
  // said nothing about them in the summary somebody reads first.
  it("counts the hours it could not check", () => {
    render(<AvailabilityGridTable grid={grid([{ kind: "unknown" }, { kind: "unknown" }])} />);
    const strip = document.querySelector("div.mb-4")?.textContent ?? "";
    expect(strip).toMatch(/2 that could not be checked/);
  });

  // An empty grid draws no key at all, rather than a box explaining nothing.
  it("draws no key when there is nothing to explain", () => {
    render(<AvailabilityGridTable grid={grid([])} />);
    expect(document.querySelectorAll("ul > li").length).toBe(0);
  });

  it("counts a full hour separately from an hour with nobody rostered", () => {
    render(<AvailabilityGridTable grid={grid(ALL_STATES)} />);
    const summary = document.querySelector("div.mb-4") as HTMLElement;

    // The two are opposite problems and the summary is what somebody reads first,
    // so collapsing them there would undo the point of the grid below it.
    expect(summary.textContent).toContain("1 bookable hours");
    expect(summary.textContent).toContain("1 with nobody rostered");
    // #1582 follow-up: a fortnight lost to leave must be readable from the
    // summary, not only from a wall of peach cells below it.
    expect(summary.textContent).toContain("1 with everyone away");
    expect(summary.textContent).toContain("1 staffed but full");
    expect(summary.textContent).toContain("1 past the horizon");
  });

  it("renders an unmeasured grid with no counts anywhere in it", () => {
    const unknown: GridCell[] = [{ kind: "unknown" }, { kind: "unknown" }];
    render(<AvailabilityGridTable grid={grid(unknown)} />);

    const cells = [...document.querySelectorAll("td > span")];
    expect(cells).toHaveLength(2);
    for (const cell of cells) {
      expect(cell.textContent).toContain("could not be checked");
      // An unmeasured cell must not quote an agent count it never had.
      expect(cell.textContent).not.toMatch(/\d+ agents? on shift/);
    }
  });
});
