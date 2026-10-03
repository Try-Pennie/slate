// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
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

const form = (days = workingHoursDays([]), userId?: string, loadedUpdatedAt: string | null = null) => (
  <WorkingHoursForm
    action={noop}
    days={days}
    timezone="America/New_York"
    timezoneLabel="Your timezone"
    userId={userId}
    loadedUpdatedAt={loadedUpdatedAt}
  />
);

/** Every value the form would submit under one field name, in DOM order. */
const values = (name: string) =>
  [...document.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)].map((i) => i.value);

const theForm = () => document.querySelector("form") as HTMLFormElement;

describe("WorkingHoursForm (#1764)", () => {
  // #3122: the save is refused when the week moved since the page was drawn, so
  // the form must carry the version it showed, exactly, and an empty value (never
  // no field) when the agent had no schedule row.
  it("submits the version of the week it was drawn from", () => {
    render(form(workingHoursDays([]), undefined, "2026-10-03T10:00:00.123456+00:00"));
    expect(values("loaded_updated_at")).toEqual(["2026-10-03T10:00:00.123456+00:00"]);
  });

  it("submits an empty version, not a missing one, when there was no schedule row", () => {
    render(form(workingHoursDays([]), undefined, null));
    expect(values("loaded_updated_at")).toEqual([""]);
  });

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

  // #1997: THE WEEK SENTENCE IS GONE, and the test that asserted it is deleted
  // rather than adjusted, because its whole content was the behaviour being
  // removed (L252). It stated the week a third time, above rows that already
  // hold every one of those times and below a banner that recites it.
  //
  // What it also covered, and what is deliberately NOT replaced: the sentence
  // tracked an UNSAVED edit. That is the thing given up, recorded on #1997. If
  // it is missed the answer is a summary shown only while edited, not this test
  // and its paragraph coming back.
  it("draws no week sentence above the rows", () => {
    render(form(workingHoursDays([1, 2, 3, 4, 5].map((d) => rule(d, 540, 1020)))));
    expect(screen.queryByTestId("hours-summary")).toBeNull();
    // The rows are still the week, which is why the sentence was redundant.
    expect(screen.getAllByRole("combobox", { name: /monday start time/i })[0]).toBeTruthy();
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
  // Still the same rule: a LIST of real zones, never free text, so an agent
  // cannot type "Eastern" and be bookable at no time at all. #1849 changed only
  // what draws the list, and the values it offers, not that rule.
  it("offers the timezone as a list of real zones, never as free text", async () => {
    const user = userEvent.setup();
    render(form(workingHoursDays([])));

    const field = screen.getByRole("combobox", { name: "Your timezone" });
    // Not a text box: there is nothing to type into.
    expect(field.tagName).not.toBe("INPUT");

    await user.click(field);
    const labels = screen.getAllByRole("option").map((o) => o.textContent ?? "");
    expect(labels.length).toBeGreaterThan(3);
    expect(labels.join(" ")).toContain("Los Angeles");

    // Every offered value is a zone the runtime accepts. The hidden input is what
    // the form posts, so that is the value worth validating.
    const posted = document.querySelector('input[name="timezone"]') as HTMLInputElement;
    expect(() => new Intl.DateTimeFormat("en-US", { timeZone: posted.value })).not.toThrow();
  });

  // #1849 REVERSED this. It used to assert that an uncurated stored zone was
  // kept as an option, which is how ten agents held zones nobody had decided to
  // allow. The list is a fixed US set now, so the rule is the opposite: an
  // unrepresentable zone resolves to a real option rather than leaving the
  // control blank or landing on whatever happens to be first, either of which
  // would move somebody's working hours without telling them.
  //
  // The roster was migrated to the list before this shipped, so nothing in
  // production actually takes this path today. It is asserted because the path
  // is what stops a future stored value failing silently.
  it("resolves a stored zone the list cannot show, rather than blanking", () => {
    render(
      <WorkingHoursForm
        action={noop}
        days={workingHoursDays([])}
        timezone="America/Puerto_Rico"
        timezoneLabel="Timezone"
        loadedUpdatedAt={null}
      />,
    );
    const posted = document.querySelector('input[name="timezone"]') as HTMLInputElement;
    expect(posted.value, "never empty, which would post nothing").not.toBe("");
    expect(posted.value).toBe("America/New_York");
    expect(screen.getByRole("combobox", { name: "Timezone" }).textContent).toContain("Eastern");
  });

  it("declares no focus ring colour of its own (#1768)", () => {
    const { container } = render(form(workingHoursDays([])));
    expect(container.innerHTML).not.toMatch(/outline-pennie-sky/);
  });
});

// #1873. Three controls under the week read as one stack, and the stack hid the
// only thing about them that matters: what each one costs if you press it by
// mistake.
//
// "Copy Monday" edits the form and saves nothing. "Save hours" is the commit.
// "Apply company default hours" writes to the database immediately AND throws
// away whatever is unsaved above it. The first and the last were rendered with
// the SAME class string, so a reversible convenience and a control that rewrites
// somebody's schedule looked identical, and the consequential one was dressed as
// a link.
describe("the three controls under the week are told apart (#1873)", () => {
  const defaults = vi.fn(async () => {});
  const companyWeek = workingHoursDays([rule(1, 540, 1020), rule(2, 540, 1020)]);

  // Both spies are module level and shared, so a test asserting one was NOT
  // called would otherwise be answered by an earlier test's click.
  beforeEach(() => {
    defaults.mockClear();
    noop.mockClear();
  });

  const withDefaults = (days = workingHoursDays([rule(1, 480, 960)])) => (
    <WorkingHoursForm
      action={noop}
      days={days}
      timezone="America/New_York"
      timezoneLabel="Your timezone"
      userId="u1"
      defaultsAction={defaults}
      companyDefaultDays={companyWeek}
      loadedUpdatedAt="2026-10-03T10:00:00.123456+00:00"
    />
  );

  const copyControl = () => screen.getByRole("button", { name: /copy monday/i });
  const applyControl = () => screen.getByRole("button", { name: /apply company default hours/i });
  /** The confirm's own alert. Scoped by content, because a time field announces
   *  its own refusals and "the alert" on this form is not unique. */
  const confirmPanel = () =>
    screen
      .queryAllByRole("alert")
      .find((el) => /company default/i.test(el.textContent ?? "")) as HTMLElement;

  it("puts the copy control in the row it edits, not beside the commit", () => {
    render(withDefaults());
    const monday = document.querySelector('[data-weekday="1"]') as HTMLElement;
    expect(monday.contains(copyControl())).toBe(true);
    // And it is not sitting with the save button at the foot of the form.
    const save = screen.getByRole("button", { name: /save/i });
    expect(monday.contains(save)).toBe(false);
  });

  it("gives the two controls different treatments, since they carry different consequences", () => {
    render(withDefaults());
    expect(applyControl().className).not.toBe(copyControl().className);
    // The one that writes is a button; the one that edits the form is not dressed
    // as its peer.
    expect(applyControl().className).toContain("pn-btn");
    expect(copyControl().className).not.toContain("pn-btn");
  });

  it("asks before applying company defaults over unsaved edits, and says what it replaces", async () => {
    const user = userEvent.setup();
    render(withDefaults());

    // An unsaved edit: Saturday is now ticked and the stored week says it is off.
    // A checkbox rather than a typed time deliberately, so the assertion below is
    // about the confirm and not about whatever a half typed time announces.
    await user.click(screen.getByRole("checkbox", { name: /saturday/i }));

    await user.click(applyControl());
    expect(defaults).not.toHaveBeenCalled();

    const asked = confirmPanel().textContent ?? "";
    // Not a generic "are you sure": it names the week it is about to write and
    // says the unsaved edits go with it.
    expect(asked).toMatch(/Monday and Tuesday, 9:00am to 5:00pm\. Wednesday to Sunday off\./i);
    expect(asked).toMatch(/unsaved/i);
  });

  it("applies them once confirmed", async () => {
    const user = userEvent.setup();
    render(withDefaults());

    await user.click(applyControl());
    await user.click(screen.getByRole("button", { name: /apply company hours anyway/i }));
    expect(defaults).toHaveBeenCalledTimes(1);
    // And it is the defaults action, never the save.
    expect(noop).not.toHaveBeenCalled();
  });

  it("backs out without writing anything when the reader cancels", async () => {
    const user = userEvent.setup();
    render(withDefaults());

    await user.click(applyControl());
    await user.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(defaults).not.toHaveBeenCalled();
    expect(confirmPanel()).toBeUndefined();
    expect(applyControl()).toBeTruthy();
  });

  it("still asks with nothing unsaved, without claiming edits it cannot see", async () => {
    const user = userEvent.setup();
    render(withDefaults());

    await user.click(applyControl());
    const asked = confirmPanel().textContent ?? "";
    // Applying still overwrites stored hours, so it still asks; there is just
    // nothing unsaved to warn about, and the copy must not say there is.
    expect(asked).toMatch(/Monday and Tuesday, 9:00am to 5:00pm\. Wednesday to Sunday off\./i);
    expect(asked).not.toMatch(/unsaved/i);
  });

  it("offers neither control on a form with no defaults action", () => {
    render(form(workingHoursDays([rule(1, 480, 960)])));
    expect(screen.queryByRole("button", { name: /apply company default hours/i })).toBeNull();
    // The copy control belongs to the week itself, so it is still there.
    expect(copyControl()).toBeTruthy();
  });
});
