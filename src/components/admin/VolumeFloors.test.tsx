// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { VolumeFloors } from "@/components/admin/VolumeFloors";
import { MEASURED_VOLUME_BASELINE } from "@/lib/monitor/volume-baseline";
import { floorTable } from "@/lib/admin/volume-floor-table";

// #1956: the floors on /admin/alerts are a MEASUREMENT, and the section has to
// say where it came from and when, and show a typed number as an override of it
// rather than as the primary input.
const WEEK = {
  rules: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start_minute: 480, end_minute: 1200 })),
};

function renderFloors(over: Partial<Parameters<typeof VolumeFloors>[0]> = {}) {
  return render(
    <VolumeFloors
      baseline={MEASURED_VOLUME_BASELINE}
      table={floorTable(MEASURED_VOLUME_BASELINE, WEEK)}
      weekReadable
      override30={null}
      override120={null}
      stored30={null}
      stored120={null}
      {...over}
    />,
  );
}

describe("VolumeFloors", () => {
  it("names the source, the measurement date, the span and whose traffic it fitted", () => {
    const { container } = renderFloors();
    const line = container.querySelector("[data-floor-provenance]")!.textContent!;
    expect(line).toContain("Measured from cal.com on Sep 25, 2026");
    expect(line).toContain("Jul 24 to Sep 25");
    expect(line).toContain(MEASURED_VOLUME_BASELINE.bookings.toLocaleString("en-US"));
    expect(line).toContain(MEASURED_VOLUME_BASELINE.scope);
    // The whole tier is fitted, so there is no share of it to state.
    expect(line).not.toContain("of that tier's bookings");
  });

  it("states the share when the floors are fitted to part of the tier", () => {
    const part = { ...MEASURED_VOLUME_BASELINE, tierShare: 0.5 };
    const { container } = renderFloors({ baseline: part, table: floorTable(part, WEEK) });
    expect(container.querySelector("[data-floor-provenance]")!.textContent).toContain("50% of that tier's bookings");
  });

  it("tables the measured 2 hour floor per open day and hour, with no Sunday", () => {
    const { container } = renderFloors();
    const table = container.querySelector('[data-floor-table="120"]')!;
    const rows = [...table.querySelectorAll("tbody tr")];
    expect(rows.map((r) => r.querySelector("th")!.textContent)).toEqual([
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
    ]);
    // Tuesday 2pm is the seventh hour column (8am first).
    const tue2pm = rows[1]!.querySelectorAll("td")[6]!;
    const cell = MEASURED_VOLUME_BASELINE.cells[1]![14]!;
    expect(tue2pm.textContent).toBe(`${cell.floor120}, usually ${cell.typical120}`);
  });

  it("tables the measured 30 minute floor when it fires at some hour", () => {
    const { container } = renderFloors();
    expect(container.querySelector('[data-floor-table="30"]')).not.toBeNull();
    expect(container.querySelector("[data-short-window-silent]")).toBeNull();
  });

  it("says once that the 30 minute window never fires, instead of a grid of zeros", () => {
    const quiet = {
      ...MEASURED_VOLUME_BASELINE,
      cells: MEASURED_VOLUME_BASELINE.cells.map((day) => day.map((c) => ({ ...c, floor30: 0 }))),
    };
    const { container } = renderFloors({ baseline: quiet, table: floorTable(quiet, WEEK) });
    expect(container.querySelector('[data-floor-table="30"]')).toBeNull();
    expect(container.querySelector("[data-short-window-silent]")).not.toBeNull();
  });

  it("reads blank overrides as the measurement", () => {
    renderFloors();
    const input = screen.getByLabelText("Last 2 hours") as HTMLInputElement;
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("measured");
    expect(document.getElementById("floor_120_state")!.textContent).toBe("Using the measured floors");
  });

  it("shows a stored value as replacing the measurement at every hour", () => {
    renderFloors({ override120: { value: 11, origin: "stored" }, stored120: 11 });
    expect((screen.getByLabelText("Last 2 hours") as HTMLInputElement).value).toBe("11");
    expect(document.getElementById("floor_120_state")!.textContent).toBe(
      "11 at every hour, in place of the measurement",
    );
    // The other window is untouched.
    expect(document.getElementById("floor_30_state")!.textContent).toBe("Using the measured floors");
  });

  it("names a deployment value as coming from the deployment, not from this form", () => {
    renderFloors({ override30: { value: 4, origin: "env" } });
    expect(document.getElementById("floor_30_state")!.textContent).toContain("set in the deployment's settings");
    expect((screen.getByLabelText("Last 30 minutes") as HTMLInputElement).value).toBe("");
  });

  it("says so when the week could not be read, rather than showing an empty table", () => {
    const { container } = render(
      <VolumeFloors
        baseline={MEASURED_VOLUME_BASELINE}
        table={floorTable(MEASURED_VOLUME_BASELINE, null)}
        weekReadable={false}
        override30={null}
        override120={null}
        stored30={null}
        stored120={null}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("could not be read");
    expect(container.querySelectorAll('[data-floor-table="120"] tbody tr')).toHaveLength(7);
  });
});
