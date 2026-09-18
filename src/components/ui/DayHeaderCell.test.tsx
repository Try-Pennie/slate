// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { DayHeaderCell } from "./DayHeaderCell";

// #2561: the availability grid and the bucket supply table each wrote the same
// two line day header out by hand. Two copies of one header is two chances for
// one table's dates to start reading differently from the other's, and neither
// component's own test would notice, because each is right about itself.
//
// The zone is the part worth pinning. A day is an ISO DATE, and the label is the
// weekday and the day of the month that date names IN THE TABLE'S OWN ZONE: read
// in the wrong zone, a date near a boundary renders as the day before.
describe("DayHeaderCell (#2561)", () => {
  const cell = (iso: string, zone: string) =>
    render(
      <table>
        <thead>
          <tr>
            <DayHeaderCell iso={iso} zone={zone} className="px-2" />
          </tr>
        </thead>
      </table>,
    );

  it("names the weekday and the day of the month", () => {
    cell("2026-09-18", "America/New_York");
    expect(screen.getByText("Fri")).toBeTruthy();
    expect(screen.getByText("18 Sep")).toBeTruthy();
  });

  it("reads the date in the zone it was given, not the machine's", () => {
    // Midnight UTC on the 18th is still the 17th in New York. The component is
    // handed a date with no time, so it must not be routed through an instant:
    // whichever zone it is told, the label is that calendar date.
    cell("2026-09-18", "UTC");
    expect(screen.getByText("Fri")).toBeTruthy();
    expect(screen.getByText("18 Sep")).toBeTruthy();
  });

  it("is a column header, so a screen reader ties every cell under it to the day", () => {
    cell("2026-09-18", "America/New_York");
    const th = screen.getByRole("columnheader");
    expect(th.getAttribute("scope")).toBe("col");
  });

  it("carries the caller's own class, because the two tables space their columns differently", () => {
    cell("2026-09-18", "America/New_York");
    expect(screen.getByRole("columnheader").className).toContain("px-2");
  });

  it("keeps the number tabular, so a column of dates lines up", () => {
    cell("2026-09-18", "America/New_York");
    expect(screen.getByText("18 Sep").className).toContain("tabular-nums");
  });
});
