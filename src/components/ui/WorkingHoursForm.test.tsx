// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { WorkingHoursForm, workingHoursDays } from "./WorkingHoursForm";

// #1308: both hours screens collapsed a week into ONE start and ONE end applied to
// every checked day, and read back only the first day's rule. The convenience half
// is obvious; the dangerous half is that the ENGINE has always honoured a window
// per weekday, so hours written by any other route were shown as the first day's
// and then destroyed by the next save, with nothing anywhere saying so.

const rule = (weekday: number, start: number, end: number) => ({
  weekday,
  start_minute: start,
  end_minute: end,
});

describe("workingHoursDays (#1308)", () => {
  it("reads each day back from its OWN rule", () => {
    const days = workingHoursDays([rule(1, 540, 1020), rule(5, 480, 960)]);

    expect(days.find((d) => d.weekday === 1)).toMatchObject({ on: true, start: "09:00", end: "17:00" });
    // The whole point: Friday keeps its own hours rather than showing Monday's.
    expect(days.find((d) => d.weekday === 5)).toMatchObject({ on: true, start: "08:00", end: "16:00" });
    expect(days.find((d) => d.weekday === 3)?.on).toBe(false);
  });

  it("ticks the usual week for an agent with nothing stored", () => {
    const days = workingHoursDays([]);
    expect(days.filter((d) => d.on).map((d) => d.weekday)).toEqual([1, 2, 3, 4, 5]);
  });

  it("honours a stored week that includes a weekend, rather than the fallback", () => {
    const days = workingHoursDays([rule(6, 600, 840)]);
    expect(days.filter((d) => d.on).map((d) => d.weekday)).toEqual([6]);
  });

  it("counts the windows a day holds that the form cannot show", () => {
    // A split shift: the engine honours both, this form can express one, and a save
    // replaces every rule for the schedule.
    const days = workingHoursDays([rule(2, 540, 720), rule(2, 780, 1020)]);
    const tuesday = days.find((d) => d.weekday === 2);

    expect(tuesday?.extraWindows).toBe(1);
    // The earliest window is the one shown, deterministically, so what the person
    // sees does not depend on the order the rows came back in.
    expect(tuesday?.start).toBe("09:00");
  });
});

describe("WorkingHoursForm (#1308)", () => {
  const noop = vi.fn(async () => {});

  it("submits a checkbox and its own pair of times for every weekday", () => {
    render(
      <WorkingHoursForm
        action={noop}
        days={workingHoursDays([rule(1, 540, 1020), rule(5, 480, 960)])}
        timezone="America/New_York"
        timezoneLabel="Your timezone"
      />,
    );

    for (const weekday of [1, 2, 3, 4, 5, 6, 7]) {
      expect(document.querySelector(`[name="day_${weekday}"]`)).toBeTruthy();
      expect(document.querySelector(`[name="start_${weekday}"]`)).toBeTruthy();
      expect(document.querySelector(`[name="end_${weekday}"]`)).toBeTruthy();
    }
    // And each field carries that day's value, not the first day's.
    expect(document.querySelector<HTMLInputElement>('[name="start_5"]')?.value).toBe("08:00");
    expect(document.querySelector<HTMLInputElement>('[name="start_1"]')?.value).toBe("09:00");
  });

  // The silent-destruction case. A row that showed one window and said nothing
  // would take the others away on a save the person thought was about something
  // else entirely.
  it("says when a day holds windows it cannot show, and what saving does to them", () => {
    render(
      <WorkingHoursForm
        action={noop}
        days={workingHoursDays([rule(2, 540, 720), rule(2, 780, 1020)])}
        timezone="America/New_York"
        timezoneLabel="Your timezone"
      />,
    );

    const notice = screen.getByText(/another window/i);
    expect(notice.textContent).toMatch(/Tuesday/);
    expect(notice.textContent).toMatch(/replaces/i);
  });

  it("stays silent about days with one window, which is nearly all of them", () => {
    render(
      <WorkingHoursForm
        action={noop}
        days={workingHoursDays([rule(1, 540, 1020)])}
        timezone="America/New_York"
        timezoneLabel="Your timezone"
      />,
    );
    expect(screen.queryByText(/window/i)).toBeNull();
  });

  it("carries the agent id on the admin's copy of the form, and not on the agent's own", () => {
    const { unmount } = render(
      <WorkingHoursForm
        action={noop}
        days={workingHoursDays([])}
        timezone="America/New_York"
        timezoneLabel="Timezone"
        userId="u1"
      />,
    );
    expect(document.querySelector<HTMLInputElement>('[name="user_id"]')?.value).toBe("u1");
    unmount();

    render(
      <WorkingHoursForm
        action={noop}
        days={workingHoursDays([])}
        timezone="America/New_York"
        timezoneLabel="Timezone"
      />,
    );
    expect(document.querySelector('[name="user_id"]')).toBeNull();
  });
});
