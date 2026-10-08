// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// #3549: the note on an advisor's own hours when cal.com holds a different week.
// The pure judgement is pinned in `scripts/test-calcom-hours-mismatch.ts`; this
// pins the WIRING: the reads it makes, that cutover stops it asking, and that a
// read it could not make reaches the screen rather than rendering as agreement.
const calcom = vi.hoisted(() => ({ readScheduleForImport: vi.fn() }));
const retirement = vi.hoisted(() => ({ loadCalcomRetiredCached: vi.fn() }));
vi.mock("@/lib/calcom/client", () => calcom);
vi.mock("@/lib/calcom/retirement", () => retirement);
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { CalcomHoursNote } from "./CalcomHoursNote";
import { CALCOM_HOURS_UNCHECKED } from "@/lib/calcom/hours-mismatch";

const SLATE = {
  timezone: "America/Chicago",
  rules: [1, 2, 3, 4, 6].map((weekday) => ({ weekday, start_minute: 480, end_minute: 1020 })),
};
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const MON_TO_FRI = {
  kind: "schedule",
  schedule: { timeZone: "America/Chicago", availability: [{ days: WEEKDAYS, startTime: "08:00", endTime: "17:00" }] },
};

async function draw() {
  const el = await CalcomHoursNote({ email: "advisor@trypennie.com", hoursSource: "agent", slate: SLATE });
  return render(<>{el}</>);
}

beforeEach(() => {
  calcom.readScheduleForImport.mockReset();
  retirement.loadCalcomRetiredCached.mockReset();
  retirement.loadCalcomRetiredCached.mockResolvedValue(false);
});

describe("CalcomHoursNote", () => {
  it("names the days cal.com holds differently, for the advisor whose week it is", async () => {
    calcom.readScheduleForImport.mockResolvedValue(MON_TO_FRI);
    await draw();
    expect(calcom.readScheduleForImport).toHaveBeenCalledWith("advisor@trypennie.com", expect.any(Number));
    expect(screen.getByRole("status").textContent).toContain("cal.com still has you working Friday and not Saturday.");
  });

  it("says a comparison it could not make, rather than drawing agreement", async () => {
    calcom.readScheduleForImport.mockResolvedValue({ kind: "rate-limited" });
    await draw();
    expect(screen.getByText(CALCOM_HOURS_UNCHECKED)).toBeTruthy();
  });

  it("says it too when the read itself throws", async () => {
    calcom.readScheduleForImport.mockRejectedValue(new Error("boom"));
    await draw();
    expect(screen.getByText(CALCOM_HOURS_UNCHECKED)).toBeTruthy();
  });

  it("draws nothing when the weeks agree", async () => {
    calcom.readScheduleForImport.mockResolvedValue({
      kind: "schedule",
      schedule: {
        timeZone: "America/Chicago",
        availability: [
          { days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Saturday"], startTime: "08:00", endTime: "17:00" },
        ],
      },
    });
    const { container } = await draw();
    expect(calcom.readScheduleForImport).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe("");
  });

  it("does not ask cal.com about a week the daily copy keeps in step", async () => {
    const el = await CalcomHoursNote({ email: "advisor@trypennie.com", hoursSource: "calcom-import", slate: SLATE });
    const { container } = render(<>{el}</>);
    expect(calcom.readScheduleForImport).not.toHaveBeenCalled();
    expect(container.textContent).toBe("");
  });

  it("does not ask cal.com once it is retired", async () => {
    retirement.loadCalcomRetiredCached.mockResolvedValue(true);
    const { container } = await draw();
    expect(calcom.readScheduleForImport).not.toHaveBeenCalled();
    expect(container.textContent).toBe("");
  });
});
