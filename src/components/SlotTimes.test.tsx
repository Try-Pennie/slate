// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { SlotTimes, SLOT_TIMES_CLASSES } from "@/components/SlotTimes";

// #1336: the booker and the two reschedule panels each owned a private copy of
// what to show while times were loading, when the load failed, and when a day
// had nothing left. This is the one component that owns those states, so a fix
// to any of them reaches every surface. The class map lets the surfaces look
// different while behaving identically.

const ZONE = "America/New_York";
const SLOT = "2026-08-15T18:00:00.000Z"; // Sat Aug 15, 2:00 PM in New York

/** The copy a sighted lead reads. The polite region below carries the same
 *  sentence for assistive tech, so a bare text query matches both. */
const visible = (text: string) =>
  screen.queryAllByText(text).filter((el) => el.closest(".sr-only") === null);

const base = {
  timeZone: ZONE,
  reader: { kind: "lead" } as const,
  onRetry: vi.fn(),
  renderSlot: (iso: string) => (
    <button key={iso} type="button">
      {iso}
    </button>
  ),
  classes: SLOT_TIMES_CLASSES.light,
  noDaysNode: <p>Nothing bookable at all.</p>,
};

describe("SlotTimes", () => {
  it("asks for a day, and renders no time, until one is chosen", () => {
    render(<SlotTimes {...base} view={{ kind: "pick-a-day" }} />);

    expect(visible("Pick a day above to see the times available.")).toHaveLength(1);
    // The rule the whole issue lands: not one clock face before a day is picked.
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  // Availability is served from a warm cache in about 40ms, so showing the dots
  // the instant a load starts makes them flash on and off on nearly every load,
  // which reads as a glitch rather than as progress. They wait out a short grace
  // period; the strip's placeholder chips carry the "loading" shape meanwhile.
  it("holds the dots back for a moment so a fast load does not flash them", () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<SlotTimes {...base} view={{ kind: "loading" }} />);

    expect(container.querySelectorAll("[data-bob-dot]")).toHaveLength(0);
    expect(visible("Finding the days you can book.")).toHaveLength(0);

    // A load that resolves inside the grace period never showed anything.
    rerender(<SlotTimes {...base} view={{ kind: "pick-a-day" }} />);
    act(() => void vi.advanceTimersByTime(2000));
    expect(container.querySelectorAll("[data-bob-dot]")).toHaveLength(0);
    vi.useRealTimers();
  });

  it("shows the bobbing dots and the loading line once the load outlasts the grace period", () => {
    vi.useFakeTimers();
    const { container } = render(<SlotTimes {...base} view={{ kind: "loading" }} />);
    act(() => void vi.advanceTimersByTime(400));
    vi.useRealTimers();

    expect(visible("Finding the days you can book.")).toHaveLength(1);
    const dots = container.querySelectorAll("[data-bob-dot]");
    expect(dots).toHaveLength(3);
    dots.forEach((dot) => {
      // Position only, never opacity: a fade spends half its cycle looking like
      // nothing is there, which is the whole reason this replaced a pulse.
      expect(dot.className).toContain("pn-bob");
      expect(dot.className).not.toContain("animate-pulse");
      // The dots carry the accent explicitly rather than inheriting the muted
      // text colour of the line below them (Dan, 2026-08-07).
      expect(dot.className).toContain("bg-accent");
    });
    // Decorative: the polite region carries the message for assistive tech.
    expect(container.querySelector("[data-bob-dots]")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("breaks a two sentence failure message between its sentences, with a retry", () => {
    const onRetry = vi.fn();
    render(<SlotTimes {...base} onRetry={onRetry} view={{ kind: "failed" }} />);

    // Each sentence is its own line, so the second never starts mid line.
    const lines = screen.getAllByText(/^(Could not load available times\.|Check your connection\.)$/);
    expect(lines).toHaveLength(2);
    screen.getByRole("button", { name: "Try again" }).click();
    expect(onRetry).toHaveBeenCalled();
  });

  it("heads the day's times with its US-order date", () => {
    render(
      <SlotTimes {...base} view={{ kind: "times", day: "2026-08-15", slots: [SLOT] }} />,
    );

    // Short form is `Sat, Aug 15`, never `Sat 15 Aug`.
    expect(screen.getByText("Times on Sat, Aug 15")).toBeTruthy();
    expect(screen.getByRole("button", { name: SLOT })).toBeTruthy();
  });

  it("names the day when it has nothing left, and says what to do next", () => {
    render(<SlotTimes {...base} view={{ kind: "day-empty", day: "2026-08-15" }} />);

    // "No times left that day. Pick another." never said another WHAT.
    expect(visible("Nothing left on Sat, Aug 15.")).toHaveLength(1);
    expect(visible("Pick another day above.")).toHaveLength(1);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("says why a day with times offers none, instead of reading as fully booked (#2310)", () => {
    render(<SlotTimes {...base} view={{ kind: "outside-calling-hours", day: "2026-08-15" }} />);

    expect(
      visible(
        "We only call between 8:00am and 8:00pm your time, and the times left on Sat, Aug 15 are all outside those hours.",
      ),
    ).toHaveLength(1);
    expect(visible("Pick another day above.")).toHaveLength(1);
    expect(visible("Nothing left on Sat, Aug 15.")).toHaveLength(0);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("hands the fully empty case to the surface's own message", () => {
    render(<SlotTimes {...base} view={{ kind: "no-days" }} />);
    expect(screen.getByText("Nothing bookable at all.")).toBeTruthy();
  });

  // #633: a lead using a screen reader must hear the outcome of choosing a day,
  // not silence. One region stays mounted across every state so the swap is
  // announced; the failure state stays quiet here because its own role=alert
  // reads it, and a double read is worse than one.
  it("announces each settled state through one persistent polite region", () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<SlotTimes {...base} view={{ kind: "loading" }} />);
    const region = () => container.querySelector("[role='status'][aria-live='polite']");

    // Silent inside the grace period: a 40ms load must not announce a load AND
    // its result back to back.
    expect(region()?.textContent).toBe("");
    act(() => void vi.advanceTimersByTime(400));
    expect(region()?.textContent).toBe("Finding the days you can book.");
    vi.useRealTimers();
    rerender(<SlotTimes {...base} view={{ kind: "pick-a-day" }} />);
    expect(region()?.textContent).toBe("Pick a day above to see the times available.");
    rerender(<SlotTimes {...base} view={{ kind: "times", day: "2026-08-15", slots: [SLOT] }} />);
    expect(region()?.textContent).toBe("1 time available on Sat, Aug 15");
    rerender(<SlotTimes {...base} view={{ kind: "day-empty", day: "2026-08-15" }} />);
    expect(region()?.textContent).toBe("Nothing left on Sat, Aug 15. Pick another day above.");
    rerender(<SlotTimes {...base} view={{ kind: "failed" }} />);
    expect(region()?.textContent).toBe("");
  });

  // #3718: the inline card shows a few times and lets the lead ask for the rest.
  describe("showing the first few times (#3718)", () => {
    const nine = Array.from({ length: 9 }, (_, i) => `2026-08-15T${String(14 + i).padStart(2, "0")}:00:00.000Z`);
    const times = (slots: string[], day = "2026-08-15") => ({ kind: "times" as const, day, slots });

    it("shows the first six and a View more times control, then every time once it is pressed", () => {
      render(<SlotTimes {...base} firstShown={6} view={times(nine)} />);
      expect(screen.queryAllByRole("button", { name: /^2026/ })).toHaveLength(6);
      fireEvent.click(screen.getByRole("button", { name: "View more times" }));
      expect(screen.queryAllByRole("button", { name: /^2026/ })).toHaveLength(9);
      expect(screen.queryByRole("button", { name: "View more times" })).toBeNull();
    });

    it("offers no control when the day has no more than that", () => {
      render(<SlotTimes {...base} firstShown={6} view={times(nine.slice(0, 6))} />);
      expect(screen.queryAllByRole("button", { name: /^2026/ })).toHaveLength(6);
      expect(screen.queryByRole("button", { name: "View more times" })).toBeNull();
    });

    it("goes back to the first six when another day is chosen", () => {
      const { rerender } = render(<SlotTimes {...base} firstShown={6} view={times(nine)} />);
      fireEvent.click(screen.getByRole("button", { name: "View more times" }));
      rerender(<SlotTimes {...base} firstShown={6} view={times(nine, "2026-08-17")} />);
      expect(screen.queryAllByRole("button", { name: /^2026/ })).toHaveLength(6);
    });

    it("folds a day again when the lead comes back to it from another", () => {
      const { rerender } = render(<SlotTimes {...base} firstShown={6} view={times(nine)} />);
      fireEvent.click(screen.getByRole("button", { name: "View more times" }));
      rerender(<SlotTimes {...base} firstShown={6} view={times(nine, "2026-08-17")} />);
      rerender(<SlotTimes {...base} firstShown={6} view={times(nine)} />);
      expect(screen.queryAllByRole("button", { name: /^2026/ })).toHaveLength(6);
    });

    it("styles View more times with its own class when the surface gives one", () => {
      render(<SlotTimes {...base} firstShown={6} classes={{ ...base.classes, viewMore: "the-more-class" }} view={times(nine)} />);
      expect(screen.getByRole("button", { name: "View more times" }).className).toBe("the-more-class");
    });

    it("leaves the day heading off when asked, and keeps it otherwise", () => {
      const { rerender } = render(<SlotTimes {...base} dayHeading={false} view={times(nine)} />);
      expect(screen.queryByText(/^Times on /)).toBeNull();
      rerender(<SlotTimes {...base} view={times(nine)} />);
      expect(screen.getByText("Times on Sat, Aug 15")).toBeTruthy();
    });

    it("shows every time, as today, when no limit is given", () => {
      render(<SlotTimes {...base} view={times(nine)} />);
      expect(screen.queryAllByRole("button", { name: /^2026/ })).toHaveLength(9);
    });
  });
});
