// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkingHoursForm } from "./WorkingHoursForm";
import { workingHoursDays } from "@/lib/schedule-week";

// #1308 gave every weekday its own window, because the engine had always honoured
// one and the form was overwriting them. #1764 finishes the job: a day can hold
// SEVERAL windows, the times are typed rather than picked from three dropdowns, and
// the week is stated in a sentence instead of having to be read off a grid.
//
// The red warning that used to sit on a split day ("Monday has another window set
// that this form cannot show. Saving replaces it") is gone, and so are its tests:
// it existed only because the form could not show what was stored, and its whole
// content was the thing being removed.

const rule = (weekday: number, start: number, end: number) => ({
  weekday,
  start_minute: start,
  end_minute: end,
});

const noop = vi.fn(async () => {});

const form = (days = workingHoursDays([]), userId?: string) => (
  <WorkingHoursForm
    action={noop}
    days={days}
    timezone="America/New_York"
    timezoneLabel="Your timezone"
    userId={userId}
  />
);

/** Every value the form would submit under one field name, in DOM order. */
const values = (name: string) =>
  [...document.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)].map((i) => i.value);

const theForm = () => document.querySelector("form") as HTMLFormElement;

describe("WorkingHoursForm (#1764)", () => {
  it("submits a checkbox and one pair of typed times per weekday", () => {
    render(form(workingHoursDays([rule(1, 540, 1020), rule(5, 480, 960)])));

    for (const weekday of [1, 2, 3, 4, 5, 6, 7]) {
      expect(document.querySelector(`[name="day_${weekday}"]`)).toBeTruthy();
      expect(values(`start_${weekday}`)).toHaveLength(1);
      expect(values(`end_${weekday}`)).toHaveLength(1);
    }
    // Each field carries that day's value, not the first day's.
    expect(values("start_5")).toEqual(["08:00"]);
    expect(values("start_1")).toEqual(["09:00"]);
  });

  it("shows BOTH windows of a split day, in start order", () => {
    render(form(workingHoursDays([rule(1, 840, 1020), rule(1, 480, 720)])));

    expect(values("start_1")).toEqual(["08:00", "14:00"]);
    expect(values("end_1")).toEqual(["12:00", "17:00"]);
    // The warning this replaces claimed a save would destroy the second window.
    expect(screen.queryByText(/cannot show/i)).toBeNull();
    expect(screen.queryByText(/Saving replaces/i)).toBeNull();
  });

  it("adds and removes a window, with controls that name the day", async () => {
    const user = userEvent.setup();
    render(form(workingHoursDays([rule(1, 540, 1020)])));

    const add = screen.getByRole("button", { name: /add a window to monday/i });
    await user.click(add);
    expect(values("start_1")).toHaveLength(2);

    // Naming the day matters on a seven row form: "Remove" alone tells a screen
    // reader nothing about which row it is on.
    const remove = screen.getByRole("button", { name: /remove monday's second window/i });
    await user.click(remove);
    expect(values("start_1")).toHaveLength(1);
  });

  it("does not offer to remove the only window a day has", () => {
    render(form(workingHoursDays([rule(1, 540, 1020)])));
    // Removing it would leave a ticked day with no times at all, which the server
    // refuses. Unticking the day is how you say you do not work it.
    expect(screen.queryByRole("button", { name: /remove monday/i })).toBeNull();
  });

  it("moves focus somewhere sensible when a row is removed", async () => {
    const user = userEvent.setup();
    render(form(workingHoursDays([rule(1, 480, 720), rule(1, 840, 1020)])));

    await user.click(screen.getByRole("button", { name: /remove monday's second window/i }));
    // Not left on a button that no longer exists, which drops focus to the body and
    // sends a keyboard user back to the top of the page.
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.tagName).not.toBe("BODY");
  });

  it("lets a blank added row through rather than refusing the save", async () => {
    const user = userEvent.setup();
    render(form(workingHoursDays([rule(1, 540, 1020)])));

    await user.click(screen.getByRole("button", { name: /add a window to monday/i }));
    // Clicking + and then saving without filling it in is an ordinary thing to do.
    expect(values("start_1")).toEqual(["09:00", ""]);
    expect(theForm().checkValidity()).toBe(true);
  });

  it("refuses a HALF filled window, because that is a mistake rather than a blank", async () => {
    const user = userEvent.setup();
    render(form(workingHoursDays([rule(1, 540, 1020)])));

    await user.click(screen.getByRole("button", { name: /add a window to monday/i }));
    const starts = screen.getAllByRole("combobox", { name: /monday start time/i });
    await user.type(starts[1], "2pm");
    await user.keyboard("{ArrowDown}{Enter}");

    // A start with no end is not a window. Letting it through would send NaN to the
    // planner, which refuses the whole week and names the day, so the person would
    // meet the refusal after the round trip instead of at the field.
    expect(theForm().checkValidity()).toBe(false);
  });

  it("keeps an unticked day's times, so dimming does not quietly remove them", async () => {
    const user = userEvent.setup();
    render(form(workingHoursDays([rule(1, 540, 1020)])));

    const saturday = screen.getByRole("checkbox", { name: /saturday/i });
    expect((saturday as HTMLInputElement).checked).toBe(false);
    expect(values("start_6")).toEqual(["09:00"]);

    // And ticking it needs no further typing: the times were there all along.
    await user.click(saturday);
    expect(values("start_6")).toEqual(["09:00"]);
    expect(theForm().checkValidity()).toBe(true);
  });

  it("marks an off day off in more than colour", () => {
    render(form(workingHoursDays([rule(1, 540, 1020)])));

    const off = document.querySelector('[data-weekday="6"]');
    expect(off?.getAttribute("data-day-off")).toBe("true");
    expect(document.querySelector('[data-weekday="1"]')?.getAttribute("data-day-off")).toBe("false");
  });

  it("recesses an off day with a FILL, never by dimming its text", () => {
    render(form(workingHoursDays([rule(1, 540, 1020)])));
    const off = document.querySelector('[data-weekday="6"]') as HTMLElement;

    // Dimming took the day name and its times to 3.69:1 and the "to" separator to
    // 2.42:1 on white, both under the 4.5:1 that body text needs, measured with axe
    // on the rendered page (#1768). A fill says the same thing and costs no
    // contrast, so the opacity utility must not come back.
    expect(off.className).not.toMatch(/\bopacity-/);
    expect(off.className).toContain("bg-[var(--bg-alt)]");
    expect((document.querySelector('[data-weekday="1"]') as HTMLElement).className).not.toMatch(
      /\bopacity-/,
    );
  });

  it("states the week in a sentence, and restates it when a time changes", async () => {
    const user = userEvent.setup();
    render(form(workingHoursDays([1, 2, 3, 4, 5].map((d) => rule(d, 540, 1020)))));

    const summary = screen.getByTestId("hours-summary");
    expect(summary.textContent).toBe("Monday to Friday, 9:00am to 5:00pm. Saturday and Sunday off.");

    // The sentence describes what is on screen, so an edit that has not been saved
    // yet still reads correctly rather than describing the stored week.
    const monday = screen.getAllByRole("combobox", { name: /monday start time/i })[0];
    await user.clear(monday);
    await user.type(monday, "8a");
    await user.keyboard("{ArrowDown}{Enter}");

    expect(summary.textContent).toBe(
      "Monday, 8:00am to 5:00pm. Tuesday to Friday, 9:00am to 5:00pm. Saturday and Sunday off.",
    );
  });

  it("copies Monday's WHOLE window list to the working days, leaving off days off", async () => {
    const user = userEvent.setup();
    render(form(workingHoursDays([rule(1, 480, 720), rule(1, 840, 1020), rule(2, 540, 1020), rule(3, 540, 1020)])));

    await user.click(screen.getByRole("button", { name: /copy monday/i }));

    // Copying a split Monday gives every working day the same split.
    expect(values("start_2")).toEqual(["08:00", "14:00"]);
    expect(values("end_2")).toEqual(["12:00", "17:00"]);
    expect(values("start_3")).toEqual(["08:00", "14:00"]);
    // Saturday is off and stays off, with its own times untouched.
    expect((screen.getByRole("checkbox", { name: /saturday/i }) as HTMLInputElement).checked).toBe(false);
    expect(values("start_6")).toEqual(["09:00"]);
  });

  it("carries the agent id on the admin's copy of the form, and not on the agent's own", () => {
    const { unmount } = render(form(workingHoursDays([]), "u1"));
    expect(document.querySelector<HTMLInputElement>('[name="user_id"]')?.value).toBe("u1");
    unmount();

    render(form(workingHoursDays([])));
    expect(document.querySelector('[name="user_id"]')).toBeNull();
  });

  // #1671: a bare text input here let an agent type "Eastern", which stores fine,
  // renders fine, and makes every weekday comparison in `isWithinWorkingHours`
  // false, so they are bookable at NO time at all with nothing telling anyone.
  it("offers the timezone as a list of real zones, never as free text", () => {
    render(form(workingHoursDays([])));

    const field = screen.getByLabelText("Your timezone");
    expect(field.tagName).toBe("SELECT");
    const zones = [...(field as HTMLSelectElement).options].map((o) => o.value);
    for (const v of zones) {
      expect(() => new Intl.DateTimeFormat("en-US", { timeZone: v })).not.toThrow();
    }
    expect(zones).toContain("America/Los_Angeles");
    expect(zones).not.toContain("Eastern");
  });

  it("keeps an uncurated stored zone as the selected option", () => {
    render(
      <WorkingHoursForm
        action={noop}
        days={workingHoursDays([])}
        timezone="America/Puerto_Rico"
        timezoneLabel="Timezone"
      />,
    );
    expect((screen.getByLabelText("Timezone") as HTMLSelectElement).value).toBe("America/Puerto_Rico");
  });

  it("declares no focus ring colour of its own (#1768)", () => {
    const { container } = render(form(workingHoursDays([])));
    expect(container.innerHTML).not.toMatch(/outline-pennie-sky/);
  });
});
