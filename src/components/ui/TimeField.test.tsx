// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TimeField } from "./TimeField";

// #1764: the hours screens asked for three dropdowns per time, so reading your own
// availability meant opening six of them. This is the one typeable control that
// replaces them, on all five screens that pick a time.
//
// The dangerous half is not the typing, it is that a typed value CAN now be wrong
// where three dropdowns made that unrepresentable. This issue decides that an
// unresolved field BLOCKS the save rather than snapping to a neighbour, because
// snapping something a person just typed moves their hours without saying so.

/** The visible text box, which is the combobox itself. */
const box = (label = "Monday start time") => screen.getByRole("combobox", { name: label });

/** An input's current text. */
const val = (el: HTMLElement) => (el as HTMLInputElement).value;

/** What the form would actually submit for this field. */
const submitted = (name = "start_1") =>
  (document.querySelector(`input[type="hidden"][name="${name}"]`) as HTMLInputElement | null)?.value;

describe("TimeField (#1764)", () => {
  it("is ONE control per time bound, not three dropdowns", () => {
    render(<TimeField name="start_1" ariaLabel="Monday start time" defaultValue="09:00" />);

    // The three way split is the thing being removed: an hour select, a minute
    // select and an AM or PM select used to stand where this one field is.
    expect(screen.queryByRole("combobox", { name: /hour$/i })).toBeNull();
    expect(screen.queryByRole("combobox", { name: /minute$/i })).toBeNull();
    expect(screen.queryByRole("combobox", { name: /AM or PM/i })).toBeNull();
    expect(screen.getAllByRole("combobox")).toHaveLength(1);
  });

  it("shows a stored value as a person reads it, and submits it in 24 hour form", () => {
    render(<TimeField name="start_1" ariaLabel="Monday start time" defaultValue="17:15" />);

    expect(val(box())).toBe("5:15pm");
    expect(submitted()).toBe("17:15");
  });

  it("offers the WHOLE day, so no storable window is unenterable", async () => {
    const user = userEvent.setup();
    render(<TimeField name="start_1" ariaLabel="Monday start time" defaultValue="09:00" />);

    await user.click(box());
    const list = screen.getByRole("listbox");
    // 96 quarter hours: a value stored at 11:45pm or 12:15am can be reached and,
    // just as importantly, can be displayed.
    expect(within(list).getAllByRole("option")).toHaveLength(96);
    expect(within(list).getByRole("option", { name: "12:00am" })).toBeTruthy();
    expect(within(list).getByRole("option", { name: "11:45pm" })).toBeTruthy();
  });

  it("filters the list as you type, so 5:15pm is a few keystrokes", async () => {
    const user = userEvent.setup();
    render(<TimeField name="start_1" ariaLabel="Monday start time" defaultValue="09:00" />);

    await user.clear(box());
    await user.type(box(), "5:");
    // A query with no am or pm matches both halves of the day, so the afternoon is
    // reachable without scrolling past the morning.
    let names = screen.getAllByRole("option").map((o) => o.textContent);
    expect(names).toEqual([
      "5:00am",
      "5:15am",
      "5:30am",
      "5:45am",
      "5:00pm",
      "5:15pm",
      "5:30pm",
      "5:45pm",
    ]);

    await user.type(box(), "15p");
    names = screen.getAllByRole("option").map((o) => o.textContent);
    expect(names).toEqual(["5:15pm"]);
  });

  it("commits a value from the keyboard alone", async () => {
    const user = userEvent.setup();
    render(<TimeField name="start_1" ariaLabel="Monday start time" defaultValue="09:00" />);

    await user.click(box());
    await user.clear(box());
    await user.type(box(), "5:15p");
    await user.keyboard("{ArrowDown}");
    // The highlighted row is named to assistive tech rather than only coloured.
    expect(box().getAttribute("aria-activedescendant")).toBeTruthy();
    await user.keyboard("{Enter}");

    expect(submitted()).toBe("17:15");
    expect(val(box())).toBe("5:15pm");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("follows the combobox pattern, so a screen reader can drive it", async () => {
    const user = userEvent.setup();
    render(<TimeField name="start_1" ariaLabel="Monday start time" defaultValue="09:00" />);

    expect(box().getAttribute("aria-expanded")).toBe("false");
    await user.click(box());
    expect(box().getAttribute("aria-expanded")).toBe("true");
    expect(box().getAttribute("aria-controls")).toBe(screen.getByRole("listbox").id);
    await user.keyboard("{Escape}");
    expect(box().getAttribute("aria-expanded")).toBe("false");
  });

  it("REFUSES an off grid time rather than snapping it to a neighbour", async () => {
    const user = userEvent.setup();
    render(
      <form>
        <TimeField name="start_1" ariaLabel="Monday start time" defaultValue="09:00" enforce />
      </form>,
    );

    await user.clear(box());
    await user.type(box(), "5:07pm");
    await user.tab();

    // Not snapped: 5:07pm is what somebody meant, and answering 5:00pm or 5:15pm
    // would move their hours without saying so.
    expect(val(box())).toBe("5:07pm");
    expect(box().getAttribute("aria-invalid")).toBe("true");
    expect(submitted()).toBe("");

    // And it BLOCKS the save rather than being merely coloured red.
    const form = document.querySelector("form") as HTMLFormElement;
    expect(form.checkValidity()).toBe(false);
  });

  it("refuses something that is not a time at all, and says which problem it is", async () => {
    const user = userEvent.setup();
    render(
      <form>
        <TimeField name="start_1" ariaLabel="Monday start time" defaultValue="09:00" enforce />
      </form>,
    );

    await user.clear(box());
    await user.type(box(), "banana");
    await user.tab();

    expect(box().getAttribute("aria-invalid")).toBe("true");
    // The refusal is announced, not only coloured. Distinct causes read
    // differently: an off grid time is a real time we do not offer, and this is not
    // a time.
    const described = box().getAttribute("aria-describedby");
    expect(described).toBeTruthy();
    const message = document.getElementById(described!.split(" ")[0]!);
    expect(message?.textContent).toMatch(/not a time/i);
    expect((document.querySelector("form") as HTMLFormElement).checkValidity()).toBe(false);
  });

  it("does not block the save on a blank field when nothing is being enforced", async () => {
    const user = userEvent.setup();
    render(
      <form>
        <TimeField name="start_6" ariaLabel="Saturday start time" defaultValue="09:00" />
      </form>,
    );

    await user.clear(box("Saturday start time"));
    await user.tab();

    // A blank window on a day nobody works, or a row somebody added and did not
    // fill in, is an ordinary thing to leave and must not refuse the whole week.
    expect((document.querySelector("form") as HTMLFormElement).checkValidity()).toBe(true);
    expect(box("Saturday start time").getAttribute("aria-invalid")).not.toBe("true");
  });

  it("snaps a stored off grid value on the way in, in the direction it was given", () => {
    // Unchanged from the three dropdown version: an END bound rounds UP so a stored
    // 5:50pm never displays as a shorter window than it really is.
    const { unmount } = render(
      <TimeField name="end_1" ariaLabel="Monday end time" defaultValue="17:50" round="up" />,
    );
    expect(submitted("end_1")).toBe("18:00");
    unmount();

    render(<TimeField name="start_1" ariaLabel="Monday start time" defaultValue="09:01" />);
    expect(submitted("start_1")).toBe("09:00");
  });

  it("reports the value it settles on, so a summary can be written from it", async () => {
    const user = userEvent.setup();
    const seen: string[] = [];
    render(
      <TimeField
        name="start_1"
        ariaLabel="Monday start time"
        defaultValue="09:00"
        onValueChange={(v) => seen.push(v)}
      />,
    );

    await user.clear(box());
    await user.type(box(), "8a");
    await user.keyboard("{ArrowDown}{Enter}");

    expect(seen.at(-1)).toBe("08:00");
  });

  it("declares no focus ring colour of its own (#1768)", () => {
    // 25 components set their own `outline-pennie-sky`, which measures 1.57:1 on
    // beige and effectively cannot be seen. One recipe, in globals.css.
    const { container } = render(
      <TimeField name="start_1" ariaLabel="Monday start time" defaultValue="09:00" />,
    );
    expect(container.innerHTML).not.toMatch(/outline-pennie-sky/);
  });
});

describe("editing part of a time (#1964)", () => {
  /**
   * A double click, as the browser really delivers it.
   *
   * Measured in Chromium: the SECOND mousedown reports the exact caret, and by
   * the time `dblclick` fires the selection has already been expanded to the
   * browser's own word, which for "5:00pm" is "00pm". jsdom does no such
   * expansion, so the expansion is applied here too, or the test would exercise
   * a gesture nobody performs and pass on a component that read the wrong
   * offset (L52).
   */
  async function doubleClickAt(el: HTMLInputElement, caret: number, browserWord: [number, number]) {
    el.focus();
    el.setSelectionRange(caret, caret);
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, detail: 1 }));
    el.setSelectionRange(caret, caret);
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, detail: 2 }));
    // What the browser does on its own before the handler runs.
    el.setSelectionRange(browserWord[0], browserWord[1]);
    el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 }));
  }

  const selected = (el: HTMLInputElement) =>
    el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0);

  it("selects the minutes alone, not the minutes and the meridiem", async () => {
    render(<TimeField name="start_1" ariaLabel="Monday start time" defaultValue="17:00" />);
    const el = box() as HTMLInputElement;
    expect(el.value).toBe("5:00pm");
    // The browser's own word for a click inside "00pm" is the whole of it.
    await doubleClickAt(el, 2, [2, 6]);
    expect(selected(el)).toBe("00");
  });

  it("selects the hour when the hour is clicked", async () => {
    render(<TimeField name="start_1" ariaLabel="Monday start time" defaultValue="17:00" />);
    const el = box() as HTMLInputElement;
    await doubleClickAt(el, 0, [0, 1]);
    expect(selected(el)).toBe("5");
  });

  it("selects the meridiem when the meridiem is clicked", async () => {
    render(<TimeField name="start_1" ariaLabel="Monday start time" defaultValue="17:00" />);
    const el = box() as HTMLInputElement;
    await doubleClickAt(el, 5, [2, 6]);
    expect(selected(el)).toBe("pm");
  });

  // THE WHOLE SEQUENCE DAN REPORTED, driven end to end: the value the form would
  // submit is the afternoon one, not the morning one twelve hours away.
  it("replacing the minutes of an afternoon time keeps the afternoon", async () => {
    const user = userEvent.setup();
    render(<TimeField name="start_1" ariaLabel="Monday start time" defaultValue="17:00" />);
    const el = box() as HTMLInputElement;
    await doubleClickAt(el, 2, [2, 6]);
    await user.keyboard("15");
    expect(el.value).toBe("5:15pm");
    await user.tab();
    expect(submitted()).toBe("17:15");
  });

  // The same field, typed rather than partially edited: a bare time in a field
  // standing on an afternoon value keeps the afternoon.
  it("a bare time typed over an afternoon value stays in the afternoon", async () => {
    const user = userEvent.setup();
    render(<TimeField name="start_1" ariaLabel="Monday start time" defaultValue="17:00" />);
    const el = box() as HTMLInputElement;
    await user.tripleClick(el);
    await user.keyboard("6:30");
    await user.tab();
    expect(submitted()).toBe("18:30");
  });

  // And a morning field is not dragged into the afternoon, which is the same
  // rule read the other way.
  it("a bare time typed over a morning value stays in the morning", async () => {
    const user = userEvent.setup();
    render(<TimeField name="start_1" ariaLabel="Monday start time" defaultValue="08:00" />);
    const el = box() as HTMLInputElement;
    await user.tripleClick(el);
    await user.keyboard("6:30");
    await user.tab();
    expect(submitted()).toBe("06:30");
  });

  it("leaves a field it cannot read to the browser", async () => {
    const user = userEvent.setup();
    render(<TimeField name="start_1" ariaLabel="Monday start time" defaultValue="17:00" />);
    const el = box() as HTMLInputElement;
    await user.tripleClick(el);
    await user.keyboard("banana");
    // The browser's own selection stands rather than being replaced by an
    // arbitrary range over text that is not a time.
    await doubleClickAt(el, 2, [0, 6]);
    expect(selected(el)).toBe("banana");
  });
});
