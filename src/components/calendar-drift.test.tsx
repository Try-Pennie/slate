// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { DateTime } from "luxon";
import { BookerCalendar } from "@/components/BookerCalendar";
import { CalendarMonth } from "@/components/ui/CalendarMonth";

// #104 drift guard. `BookerCalendar` (consumer embed) and `CalendarMonth`
// (internal date picker) are deliberately decoupled copies of the same month
// grid: roving-focus arrow-key navigation, week/edge wrap, disabled-day
// handling, and the rendered grid. Because they are separate files, a bug fixed
// (or introduced) in one can silently skip the other. This test drives the
// IDENTICAL interaction script against both and asserts their observable
// behavior is identical, so any drift in the shared logic turns it red. When it
// fails, mirror the change into the other component (see both docstrings).

type CalendarProps = {
  month: DateTime;
  today: DateTime;
  onMonthChange: (m: DateTime) => void;
  canPrev: boolean;
  canNext: boolean;
  isSelected: (d: DateTime) => boolean;
  isDisabled: (d: DateTime) => boolean;
  onSelect: (d: DateTime) => void;
};

type CalendarComponent = (props: CalendarProps) => React.ReactNode;

const COMPONENTS: ReadonlyArray<readonly [string, CalendarComponent]> = [
  ["BookerCalendar", BookerCalendar],
  ["CalendarMonth", CalendarMonth],
];

// A deterministic month with a clean shape for edge tests: March 2026 starts on
// a Sunday (lead = 0) and has 31 days, so the last day sits mid-week and
// ArrowRight past it must roll into April.
const INITIAL_MONTH = DateTime.fromISO("2026-03-01");
const TODAY = DateTime.fromISO("2026-03-17");
const DISABLED_ISO = "2026-03-10";

// A stateful harness so month-crossing navigation (which calls onMonthChange)
// re-renders the grid the way the real parents do. Selection is derived from a
// single controlled ISO so `isSelected` is observable across both components.
function Harness({
  Component,
  onSelectSpy,
}: {
  Component: CalendarComponent;
  onSelectSpy: (iso: string) => void;
}) {
  const [month, setMonth] = useState(INITIAL_MONTH);
  const [selectedIso, setSelectedIso] = useState<string | null>(null);
  return (
    <Component
      month={month}
      today={TODAY}
      onMonthChange={setMonth}
      canPrev
      canNext
      isSelected={(d) => d.toISODate() === selectedIso}
      isDisabled={(d) => d.toISODate() === DISABLED_ISO}
      onSelect={(d) => {
        setSelectedIso(d.toISODate());
        onSelectSpy(d.toISODate()!);
      }}
    />
  );
}

const grid = (c: HTMLElement) =>
  c.querySelector(".grid.grid-cols-7.gap-0\\.5") as HTMLElement;

const monthLabel = (c: HTMLElement) =>
  (c.querySelector("span.text-sm.font-semibold") as HTMLElement).textContent;

const dayButtons = (c: HTMLElement) =>
  Array.from(grid(c).querySelectorAll<HTMLButtonElement>("button[data-key]"));

// The one tabbable day cell (roving tabindex). Identifies where focus sits.
const rovingKey = (c: HTMLElement) =>
  dayButtons(c).find((b) => b.tabIndex === 0)?.dataset.key ?? null;

const activeKey = () =>
  (document.activeElement as HTMLElement | null)?.getAttribute("data-key") ??
  null;

// Drive a key on the current roving cell. fireEvent wraps the dispatch in
// act(), so the state update and the focus-moving effect both flush before the
// next read, mirroring what the browser does on a real keystroke.
const press = (c: HTMLElement, key: string) => {
  const target =
    grid(c).querySelector<HTMLButtonElement>(`button[data-key="${rovingKey(c)}"]`) ??
    dayButtons(c)[0];
  target.focus();
  fireEvent.keyDown(target, { key });
};

/**
 * Run the identical script against one component and record every observable
 * signal into a trace. Comparing two traces for deep equality is the drift
 * assertion: same inputs, same behavior.
 */
function traceOf(Component: CalendarComponent) {
  const selects: string[] = [];
  const { container } = render(
    <Harness Component={Component} onSelectSpy={(iso) => selects.push(iso)} />,
  );

  const trace: Record<string, unknown> = {};

  // Initial render: the month grid itself.
  trace.initialMonthLabel = monthLabel(container);
  trace.dayKeys = dayButtons(container).map((b) => b.dataset.key);
  trace.leadingBlanks = grid(container).querySelectorAll("span").length;
  trace.ariaLabels = dayButtons(container).map((b) =>
    b.getAttribute("aria-label"),
  );
  trace.initialRoving = rovingKey(container);

  // Disabled-day semantics: focusable (aria-disabled, not the disabled attr) but
  // not selectable.
  const disabledBtn = dayButtons(container).find(
    (b) => b.dataset.key === DISABLED_ISO,
  )!;
  trace.disabledAriaDisabled = disabledBtn.getAttribute("aria-disabled");
  trace.disabledHasDisabledAttr = disabledBtn.hasAttribute("disabled");
  fireEvent.click(disabledBtn);
  trace.selectsAfterDisabledClick = [...selects];

  // Today marker.
  const todayBtn = dayButtons(container).find(
    (b) => b.dataset.key === TODAY.toISODate(),
  )!;
  trace.todayAriaCurrent = todayBtn.getAttribute("aria-current");

  // Roving-focus arrow navigation across the grid.
  press(container, "ArrowRight");
  trace.afterRight = activeKey();
  press(container, "ArrowDown");
  trace.afterDown = activeKey();
  press(container, "ArrowUp");
  trace.afterUp = activeKey();
  press(container, "ArrowLeft");
  trace.afterLeft = activeKey();

  // Home/End jump to the week edges.
  press(container, "Home");
  trace.afterHome = activeKey();
  press(container, "End");
  trace.afterEnd = activeKey();

  // Wrap at the month edge: walk to the last day, one more ArrowRight rolls into
  // the next month and the label must change with it.
  const last = INITIAL_MONTH.endOf("month").toISODate();
  let guard = 0;
  while (activeKey() !== last && guard++ < 40) press(container, "ArrowRight");
  trace.reachedLastDay = activeKey();
  press(container, "ArrowRight");
  trace.afterWrapMonthLabel = monthLabel(container);
  trace.afterWrapRoving = rovingKey(container);

  // PageDown / PageUp change month by one.
  press(container, "PageDown");
  trace.afterPageDownLabel = monthLabel(container);
  press(container, "PageUp");
  trace.afterPageUpLabel = monthLabel(container);

  // Selecting an enabled day fires onSelect and reflects aria-pressed.
  const enabled = dayButtons(container).find(
    (b) => b.getAttribute("aria-disabled") == null,
  )!;
  fireEvent.click(enabled);
  trace.selectsAfterEnabledClick = [...selects];

  return trace;
}

describe("BookerCalendar and CalendarMonth stay in sync (#104)", () => {
  afterEach(cleanup);

  it("produce identical behavior for the same interaction script", () => {
    const bookerTrace = traceOf(BookerCalendar);
    cleanup();
    const calendarTrace = traceOf(CalendarMonth);

    expect(calendarTrace).toEqual(bookerTrace);
  });

  it("both render a full, correctly shaped month grid (script sanity)", () => {
    // Guards against the traces matching only because both silently render
    // nothing: assert the shared script actually exercised a real grid.
    for (const [, Component] of COMPONENTS) {
      const trace = traceOf(Component);
      cleanup();
      expect(trace.initialMonthLabel).toBe("March 2026");
      expect((trace.dayKeys as string[]).length).toBe(31);
      expect(trace.afterWrapMonthLabel).toBe("April 2026");
      expect(trace.selectsAfterDisabledClick).toEqual([]);
      expect((trace.selectsAfterEnabledClick as string[]).length).toBe(1);
    }
  });
});
