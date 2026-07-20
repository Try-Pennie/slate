// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DateTime } from "luxon";
import { BookerStrip, BookerStripSkeleton } from "@/components/BookerStrip";

// #261: when the whole rolling week has no bookable day, the strip used to show a
// "No times available in the next few days" message AND all seven greyed/disabled
// day chips together, which read oddly and duplicated the times panel's own empty
// message ("All times are taken right now. Check back soon."). The strip should
// instead render nothing in that case and let the times panel own the single
// empty affordance. When some days ARE bookable, the chips render as before.

const ZONE = "America/New_York";
// 2026-07-20 is a Monday, so the rolling week 07-20..07-26 has non-Sunday days.
const TODAY = DateTime.fromISO("2026-07-20", { zone: ZONE });

describe("BookerStrip empty-window state (#261)", () => {
  it("renders nothing (no chips, no competing message) when no day is bookable", () => {
    const { container } = render(
      <BookerStrip today={TODAY} availableDays={[]} activeDay={null} zone={ZONE} onSelect={vi.fn()} />,
    );

    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByText(/no times available/i)).toBeNull();
    // The strip contributes nothing to the layout in the empty case.
    expect(container.textContent).toBe("");
  });

  it("renders the day chips when at least one day is bookable", () => {
    render(
      <BookerStrip
        today={TODAY}
        availableDays={["2026-07-21"]} // Tuesday, bookable
        activeDay={null}
        zone={ZONE}
        onSelect={vi.fn()}
      />,
    );

    const chips = screen.getAllByRole("button");
    expect(chips).toHaveLength(7); // the full rolling week is shown
    // The bookable day's chip is enabled; a non-available day's chip is disabled.
    const enabled = chips.filter((b) => !(b as HTMLButtonElement).disabled);
    expect(enabled).toHaveLength(1);
  });
});

// #252: the cold-case loading treatment. The strip area shows a branded skeleton
// (not a blank gap, not a bare spinner) while availability is in flight, and the
// pulse stops under prefers-reduced-motion.
describe("BookerStripSkeleton (#252)", () => {
  it("renders a full week of placeholder chips, hidden from assistive tech", () => {
    const { container } = render(<BookerStripSkeleton skeletonClass="bg-fg/10" />);
    const chips = container.querySelectorAll("[data-skeleton-chip]");
    expect(chips).toHaveLength(7);
    // Decorative: the polite region announces "Loading available times", so the
    // skeleton itself is aria-hidden.
    expect(container.querySelector("[aria-hidden='true']")).not.toBeNull();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("honors prefers-reduced-motion (pulse disabled) on every placeholder", () => {
    const { container } = render(<BookerStripSkeleton skeletonClass="bg-fg/10" />);
    const chips = container.querySelectorAll("[data-skeleton-chip]");
    chips.forEach((chip) => {
      expect(chip.className).toContain("animate-pulse");
      expect(chip.className).toContain("motion-reduce:animate-none");
    });
  });
});
