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

const ALL_STATES: GridCell[] = [
  { kind: "open", agents: 3, buckets: 42 },
  { kind: "booked", agents: 3 },
  { kind: "unrostered" },
  { kind: "beyond-horizon", agents: 2 },
  { kind: "closed", note: "Christmas Day" },
];

describe("AvailabilityGridTable (#1302)", () => {
  it("says what every cell means, in the words the builder produces", () => {
    render(<AvailabilityGridTable grid={grid(ALL_STATES)} />);

    // The exact builder output, on screen. Anything less would let the component
    // drift back to holding its own sentence while the builder read fine (L41).
    expect(screen.getByText(cellTitle(ALL_STATES[0], "Monday 24 August", 9))).toBeTruthy();
    expect(screen.getByText(cellTitle(ALL_STATES[2], "Wednesday 26 August", 9))).toBeTruthy();
    expect(screen.getByText(cellTitle(ALL_STATES[4], "Friday 28 August", 9))).toBeTruthy();
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

  it("explains every state it can render, so no letter is unexplained", () => {
    render(<AvailabilityGridTable grid={grid(ALL_STATES)} />);
    const legend = document.querySelectorAll("ul > li");

    expect(legend.length).toBe(CELL_TREATMENTS.length);
    for (const t of CELL_TREATMENTS) {
      expect(screen.getByText(t.label)).toBeTruthy();
      expect(screen.getByText(t.meaning, { exact: false })).toBeTruthy();
    }
  });

  it("counts a full hour separately from an hour with nobody rostered", () => {
    render(<AvailabilityGridTable grid={grid(ALL_STATES)} />);
    const summary = document.querySelector("div.mb-4") as HTMLElement;

    // The two are opposite problems and the summary is what somebody reads first,
    // so collapsing them there would undo the point of the grid below it.
    expect(summary.textContent).toContain("1 bookable hours");
    expect(summary.textContent).toContain("1 with nobody rostered");
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
