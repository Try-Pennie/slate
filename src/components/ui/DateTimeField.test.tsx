// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DateTimeField } from "@/components/ui/DateTimeField";
import { roundUpToQuarterHour } from "@/lib/date/parse";

// The pure "HH:MM" parser (src/lib/date/parse.ts) has its own coverage; this
// file exercises the segmented click/type behavior of the field itself, which
// shipped three bugs found only by manual runs (PR #121, #123): an onBlur value
// wipe that read stale closure state instead of the freshly typed value,
// directional minute rounding (Start floors, End ceils), and the click-to-type
// focus gap. Each test below is written to fail if its fix is reverted.

const BOUNDS = { min: "2024-01-01", max: "2028-12-31", todayISO: "2026-06-17" };

function renderField(extra: Record<string, unknown> = {}) {
  return render(
    <DateTimeField
      nameDate="d"
      nameTime="t"
      ariaLabel="Start"
      min={BOUNDS.min}
      max={BOUNDS.max}
      todayISO={BOUNDS.todayISO}
      {...extra}
    />,
  );
}

const activeLabel = () =>
  (document.activeElement as HTMLElement | null)?.getAttribute("aria-label") ??
  null;

const hiddenValue = (container: HTMLElement, name: string) =>
  (container.querySelector(`input[name="${name}"]`) as HTMLInputElement).value;

describe("DateTimeField segment auto-advance", () => {
  it("moves focus to the next segment once a segment fills", async () => {
    const u = userEvent.setup();
    const { getByLabelText } = renderField();
    const mm = getByLabelText("Start, month") as HTMLInputElement;

    await u.click(mm);
    await u.type(mm, "12");
    // Two digits complete the month, so focus jumps to the day segment.
    expect(mm.value).toBe("12");
    expect(activeLabel()).toBe("Start, day");

    await u.type(document.activeElement as HTMLInputElement, "25");
    expect((getByLabelText("Start, day") as HTMLInputElement).value).toBe("25");
    expect(activeLabel()).toBe("Start, year");
  });

  it("auto-pads and advances on a first digit that can only be one value", async () => {
    const u = userEvent.setup();
    const { getByLabelText } = renderField();
    const mm = getByLabelText("Start, month") as HTMLInputElement;

    await u.click(mm);
    // "5" cannot start a two-digit month, so it becomes "05" and advances.
    await u.type(mm, "5");
    expect(mm.value).toBe("05");
    expect(activeLabel()).toBe("Start, day");
  });
});

describe("DateTimeField onBlur reads the freshly typed value (stale-closure wipe)", () => {
  // Auto-advance fires blur on the segment just left, in the same tick as the
  // keystroke, so the blur handler's captured React state is still the PREVIOUS
  // value. The fix reads e.currentTarget.value; reverting it to the closure
  // variable corrupts the value on advance (e.g. "12" -> "01").
  it("keeps a valid two-digit month typed right before auto-advance", async () => {
    const u = userEvent.setup();
    const { getByLabelText } = renderField();
    const mm = getByLabelText("Start, month") as HTMLInputElement;

    await u.click(mm);
    await u.type(mm, "12");
    // Reading stale closure state here would write "01" (the digit before the
    // advancing keystroke padded), silently corrupting December into January.
    expect(mm.value).toBe("12");
  });

  it("clamps an out-of-range month from the fresh value, not the stale digit", async () => {
    const u = userEvent.setup();
    const { getByLabelText } = renderField();
    const mm = getByLabelText("Start, month") as HTMLInputElement;

    await u.click(mm);
    await u.type(mm, "13");
    // Fresh value "13" clamps to "12"; the stale closure ("1") would land "01".
    expect(mm.value).toBe("12");
  });

  it("normalizes a day against its month from the event value on blur", () => {
    const { getByLabelText } = renderField();
    const mm = getByLabelText("Start, month") as HTMLInputElement;
    const dd = getByLabelText("Start, day") as HTMLInputElement;

    fireEvent.change(mm, { target: { value: "02" } });
    fireEvent.change(dd, { target: { value: "99" } });
    fireEvent.blur(dd);
    // Feb caps at 29 (leap-year bound while the year is blank).
    expect(dd.value).toBe("29");
  });
});

describe("DateTimeField directional minute rounding", () => {
  it("floors a typed minute for a Start field (round=down)", () => {
    const { getByLabelText, container } = renderField({ round: "down" });
    const hh = getByLabelText("Start, hour") as HTMLInputElement;
    const mi = getByLabelText("Start, minute") as HTMLInputElement;

    fireEvent.change(hh, { target: { value: "09" } });
    fireEvent.blur(hh);
    fireEvent.change(mi, { target: { value: "07" } });
    fireEvent.blur(mi);

    expect(mi.value).toBe("00");
    expect(hiddenValue(container, "t")).toBe("09:00");
  });

  it("ceils a typed minute for an End field (round=up)", () => {
    const { getByLabelText, container } = renderField({ round: "up" });
    const hh = getByLabelText("Start, hour") as HTMLInputElement;
    const mi = getByLabelText("Start, minute") as HTMLInputElement;

    fireEvent.change(hh, { target: { value: "09" } });
    fireEvent.blur(hh);
    fireEvent.change(mi, { target: { value: "07" } });
    fireEvent.blur(mi);

    // Rounding up so the window never shrinks: :07 -> :15.
    expect(mi.value).toBe("15");
    expect(hiddenValue(container, "t")).toBe("09:15");
  });

  // The test that used to sit here asserted that a rounded up minute clamps to
  // :45 "instead of rolling into the next hour". That is the defect #1765
  // measured, not a decision: this field's own comment says an END time rounds up
  // so that "rounding never shrinks the window", and answering :45 for :50
  // shortens it by fourteen minutes. Its whole content was the rejected
  // behaviour, so it is deleted rather than adjusted, and replaced by the rule it
  // got wrong.
  it("carries a rounded up END minute into the hour rather than shortening the window", () => {
    const { getByLabelText, container } = renderField({ round: "up" });
    const hh = getByLabelText("Start, hour") as HTMLInputElement;
    const mi = getByLabelText("Start, minute") as HTMLInputElement;
    const ap = getByLabelText("Start, AM or PM") as HTMLInputElement;

    fireEvent.change(hh, { target: { value: "05" } });
    fireEvent.blur(hh);
    fireEvent.keyDown(ap, { key: "p" });
    fireEvent.change(mi, { target: { value: "50" } });
    fireEvent.blur(mi);

    // 5:50pm asked for. Answering 5:45pm leaves fourteen minutes of a day the
    // agent meant to block still bookable.
    expect(hiddenValue(container, "t")).toBe("18:00");
    expect(hh.value).toBe("06");
    expect(mi.value).toBe("00");
    expect(ap.value).toBe("PM");
  });

  it("still clamps the last quarter of the day rather than spilling into tomorrow", () => {
    const { getByLabelText, container } = renderField({ round: "up" });
    const hh = getByLabelText("Start, hour") as HTMLInputElement;
    const mi = getByLabelText("Start, minute") as HTMLInputElement;
    const ap = getByLabelText("Start, AM or PM") as HTMLInputElement;

    fireEvent.change(hh, { target: { value: "11" } });
    fireEvent.blur(hh);
    fireEvent.keyDown(ap, { key: "p" });
    fireEvent.change(mi, { target: { value: "50" } });
    fireEvent.blur(mi);

    // The one legitimate clamp, and the reason the rule is "round on total
    // minutes" rather than "never touch the hour": 11:50pm has no later quarter
    // to round to on the same date.
    expect(hiddenValue(container, "t")).toBe("23:45");
  });

  // The disagreement this issue exists to remove. Both time pickers now answer
  // from the same helper, so the same keystrokes cannot round one way here and
  // another way on the hours screens. Each implementation used to be tested
  // against itself, which is why two spellings of one rule survived.
  it("agrees with the shared rule the hours screens use", () => {
    for (const [typed, expected] of [
      ["50", "18:00"],
      ["46", "18:00"],
      ["59", "18:00"],
      ["07", "17:15"],
      ["00", "17:00"],
      ["15", "17:15"],
    ] as [string, string][]) {
      const { getByLabelText, container, unmount } = renderField({ round: "up" });
      const hh = getByLabelText("Start, hour") as HTMLInputElement;
      const mi = getByLabelText("Start, minute") as HTMLInputElement;
      const ap = getByLabelText("Start, AM or PM") as HTMLInputElement;

      fireEvent.change(hh, { target: { value: "05" } });
      fireEvent.blur(hh);
      fireEvent.keyDown(ap, { key: "p" });
      fireEvent.change(mi, { target: { value: typed } });
      fireEvent.blur(mi);

      // The shared helper is the authority, so the expectation is computed from
      // it rather than written out twice.
      expect(roundUpToQuarterHour(`17:${typed}`)).toBe(expected);
      expect(hiddenValue(container, "t")).toBe(expected);
      unmount();
    }
  });
});

describe("DateTimeField click-to-type focus", () => {
  it("focuses the first empty segment when the field padding is clicked", () => {
    const { container } = renderField();
    const group = container.querySelector('[role="group"]') as HTMLElement;

    // A mousedown that lands on the group padding (not a segment or the button)
    // should drop the cursor into the first empty segment.
    fireEvent.mouseDown(group, { target: group });
    expect(activeLabel()).toBe("Start, month");
  });

  it("skips filled segments and focuses the next empty one", () => {
    const { getByLabelText, container } = renderField();
    const mm = getByLabelText("Start, month") as HTMLInputElement;
    const dd = getByLabelText("Start, day") as HTMLInputElement;
    const group = container.querySelector('[role="group"]') as HTMLElement;

    fireEvent.change(mm, { target: { value: "02" } });
    fireEvent.change(dd, { target: { value: "14" } });

    fireEvent.mouseDown(group, { target: group });
    expect(activeLabel()).toBe("Start, year");
  });

  it("does not steal focus when the mousedown lands on a segment input", () => {
    const { getByLabelText } = renderField();
    const dd = getByLabelText("Start, day") as HTMLInputElement;

    dd.focus();
    // The mousedown bubbles to the group with the day input as its target, so
    // the group handler must bail out (its closest("input") guard) and leave the
    // browser's native caret placement, keeping focus on the clicked segment.
    fireEvent.mouseDown(dd);
    expect(activeLabel()).toBe("Start, day");
  });
});

// #2048: dismissing the popup is not the same gesture as cancelling it.
//
// `AnchoredPanel` dismisses on an outside mousedown AND on any page scroll
// outside the panel, and this field had that wired to `cancel()`, which writes the
// pre-open snapshot back over whatever was picked. So a click aimed at anything
// else on the page, or a scroll, silently erased a date somebody had just chosen,
// with no undo.
//
// Both directions are asserted, because removing the revert altogether would pass
// a one-sided test: an incidental dismissal KEEPS the value, and the two explicit
// cancel gestures (the Cancel button, Escape) still restore the snapshot (L628).
describe("DateTimeField dismiss keeps the value, cancel restores it", () => {
  const openPopup = async (u: ReturnType<typeof userEvent.setup>, getByLabelText: (t: string) => HTMLElement) => {
    await u.click(getByLabelText("Open calendar and time"));
  };

  it("keeps a date picked in the grid when the popup is dismissed by an outside click", async () => {
    const u = userEvent.setup();
    const { container, getByLabelText } = renderField();

    await openPopup(u, getByLabelText);
    await u.click(getByLabelText("Thursday, June 25, 2026"));
    expect(hiddenValue(container, "d")).toBe("2026-06-25");

    // A mousedown on the page, not aimed at the picker at all.
    fireEvent.mouseDown(document.body);

    expect(hiddenValue(container, "d")).toBe("2026-06-25");
    expect((getByLabelText("Start, day") as HTMLInputElement).value).toBe("25");
  });

  it("keeps a date picked in the grid when the page is scrolled", async () => {
    const u = userEvent.setup();
    const { container, getByLabelText } = renderField();

    await openPopup(u, getByLabelText);
    await u.click(getByLabelText("Thursday, June 25, 2026"));

    // AnchoredPanel listens for scroll in the capture phase on window.
    fireEvent.scroll(window);

    expect(hiddenValue(container, "d")).toBe("2026-06-25");
  });

  it("restores the snapshot when Cancel is pressed", async () => {
    const u = userEvent.setup();
    const { container, getByLabelText, getByText } = renderField({
      defaultDate: "2026-06-10",
      defaultTime: "09:00",
    });

    await openPopup(u, getByLabelText);
    await u.click(getByLabelText("Thursday, June 25, 2026"));
    expect(hiddenValue(container, "d")).toBe("2026-06-25");

    await u.click(getByText("Cancel"));

    // Explicitly abandoning the picker puts back what the field held before.
    expect(hiddenValue(container, "d")).toBe("2026-06-10");
  });

  it("restores the snapshot when Escape is pressed", async () => {
    const u = userEvent.setup();
    const { container, getByLabelText } = renderField({
      defaultDate: "2026-06-10",
      defaultTime: "09:00",
    });

    await openPopup(u, getByLabelText);
    await u.click(getByLabelText("Thursday, June 25, 2026"));

    fireEvent.keyDown(document, { key: "Escape" });

    expect(hiddenValue(container, "d")).toBe("2026-06-10");
  });

  it("commits on Confirm, the same outcome a dismissal now gives", async () => {
    const u = userEvent.setup();
    const { container, getByLabelText, getByText } = renderField({
      defaultDate: "2026-06-10",
    });

    await openPopup(u, getByLabelText);
    await u.click(getByLabelText("Thursday, June 25, 2026"));
    await u.click(getByText("Confirm"));

    expect(hiddenValue(container, "d")).toBe("2026-06-25");
  });
});

// #2048 fault 2: the popup's own time control read the segments once, when it
// mounted, and never again. Typing a time into the field while the popup was open
// left the two controls showing one value and disagreeing about it (L605).
describe("DateTimeField popup time control tracks the segments", () => {
  it("shows a time typed into the segments after the popup was opened", async () => {
    const u = userEvent.setup();
    const { getByLabelText } = renderField();

    await u.click(getByLabelText("Open calendar and time"));

    // The popup is open and its time box is empty, matching the empty segments.
    const popupTime = getByLabelText("Start time") as HTMLInputElement;
    expect(popupTime.value).toBe("");

    const hh = getByLabelText("Start, hour") as HTMLInputElement;
    await u.click(hh);
    await u.type(hh, "10");
    const mi = getByLabelText("Start, minute") as HTMLInputElement;
    await u.type(mi, "30");
    fireEvent.blur(mi, { target: { value: "30" } });

    // The two controls now agree.
    expect((getByLabelText("Start time") as HTMLInputElement).value).toBe("10:30am");
  });

  it("still opens on the segments' current value", async () => {
    const u = userEvent.setup();
    const { getByLabelText } = renderField({ defaultTime: "14:15" });

    await u.click(getByLabelText("Open calendar and time"));

    expect((getByLabelText("Start time") as HTMLInputElement).value).toBe("2:15pm");
  });
});

// #3081: the popup said role="dialog" aria-modal="true" and then left focus on
// the button that opened it, so a keyboard user was told a modal had opened and
// was standing outside it. It is NOT modal (a click elsewhere or a scroll closes
// it and the page stays live), so the promise is withdrawn rather than faked, and
// focus is moved in and handed back the way a popup's should be.
describe("DateTimeField popup focus (#3081)", () => {
  it("does not claim to be modal", async () => {
    const u = userEvent.setup();
    const { getByLabelText, getByRole } = renderField();
    await u.click(getByLabelText("Open calendar and time"));
    expect(getByRole("dialog").getAttribute("aria-modal")).toBeNull();
  });

  it("moves focus onto the selected day when it opens", async () => {
    const u = userEvent.setup();
    const { getByLabelText } = renderField({ defaultDate: "2026-06-10" });
    await u.click(getByLabelText("Open calendar and time"));
    expect(activeLabel()).toBe("Wednesday, June 10, 2026");
  });

  it("moves focus into the grid when no day is chosen yet", async () => {
    const u = userEvent.setup();
    const { getByLabelText } = renderField();
    await u.click(getByLabelText("Open calendar and time"));
    expect(activeLabel()).toBe("Wednesday, June 17, 2026");
  });

  it.each(["Cancel", "Confirm"])("hands focus back to the calendar button on %s", async (name) => {
    const u = userEvent.setup();
    const { getByLabelText, getByText } = renderField({ defaultDate: "2026-06-10" });
    await u.click(getByLabelText("Open calendar and time"));
    await u.click(getByText(name));
    expect(activeLabel()).toBe("Open calendar and time");
  });

  it("hands focus back to the calendar button on Escape", async () => {
    const u = userEvent.setup();
    const { getByLabelText } = renderField({ defaultDate: "2026-06-10" });
    await u.click(getByLabelText("Open calendar and time"));
    await u.keyboard("{Escape}");
    expect(activeLabel()).toBe("Open calendar and time");
  });
});
