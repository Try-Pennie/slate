// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DateTime } from "luxon";
import { BookerStrip, BookerStripSkeleton } from "@/components/BookerStrip";

// #261: when nothing is bookable the strip renders nothing at all and lets the
// times panel own the single empty affordance, rather than showing a row of
// greyed chips plus a message that competes with it.
//
// #1336 / #1298 / #1330: the strip renders the days the booker can actually
// offer, walking past closed days, instead of a fixed seven day window with the
// unbookable days greyed out. Three consequences pinned below:
//  - there is no greyed remainder, so every chip is pressable;
//  - a skipped day is marked, so a closed day is visible rather than silently
//    absent between two chips;
//  - every chip carries its month, so a month boundary never reads as a date in
//    the past and neighbouring chips stay the same shape.

const ZONE = "America/New_York";
// 2026-08-13 is a Thursday, so Fri/Sat/Mon exercises a skipped Sunday.
const TODAY = DateTime.fromISO("2026-08-13", { zone: ZONE });

describe("BookerStrip empty-window state (#261)", () => {
  it("renders nothing (no chips, no competing message) when no day is bookable", () => {
    const { container } = render(
      <BookerStrip today={TODAY} days={[]} activeDay={null} zone={ZONE} onSelect={vi.fn()} />,
    );

    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByText(/no times available/i)).toBeNull();
    expect(container.textContent).toBe("");
  });
});

describe("BookerStrip renders the offered days (#1336)", () => {
  it("draws one pressable chip per offered day and nothing else", () => {
    render(
      <BookerStrip
        today={TODAY}
        days={["2026-08-13", "2026-08-14", "2026-08-15"]}
        activeDay={null}
        zone={ZONE}
        onSelect={vi.fn()}
      />,
    );

    const chips = screen.getAllByRole("button");
    expect(chips).toHaveLength(3);
    // No greyed remainder: an unbookable day is simply not drawn, so there is
    // never a disabled chip for a lead to wonder about.
    expect(chips.filter((b) => (b as HTMLButtonElement).disabled)).toHaveLength(0);
    // #260: a uniform min width keeps chips tappable and scrolling rather than
    // squishing to label length on a narrow phone.
    chips.forEach((chip) => expect(chip.className).toContain("min-w-16"));
  });

  it("labels day zero TODAY, later days by weekday, and every chip with its month", () => {
    render(
      <BookerStrip
        today={TODAY}
        days={["2026-08-13", "2026-08-14"]}
        activeDay={null}
        zone={ZONE}
        onSelect={vi.fn()}
      />,
    );

    const chips = screen.getAllByRole("button");
    expect(chips[0].textContent).toContain("TODAY");
    expect(chips[0].textContent).toContain("13");
    expect(chips[1].textContent).toContain("FRI");
    expect(chips[1].textContent).toContain("14");
    // Every chip, not only the ones where the month changes (Dan, 2026-08-07).
    chips.forEach((chip) => expect(chip.textContent).toContain("AUG"));
  });

  it("marks a skipped day with a gap rule between the chips either side", () => {
    const { container } = render(
      <BookerStrip
        today={TODAY}
        // Fri, Sat, then Mon: Sunday is skipped.
        days={["2026-08-14", "2026-08-15", "2026-08-17"]}
        activeDay={null}
        zone={ZONE}
        onSelect={vi.fn()}
      />,
    );

    const gaps = container.querySelectorAll("[data-day-gap]");
    expect(gaps).toHaveLength(1);
    // Decorative: assistive tech gets the dates from the chips themselves.
    gaps.forEach((g) => expect(g.getAttribute("aria-hidden")).toBe("true"));
  });

  it("draws no gap rule when every offered day is consecutive", () => {
    const { container } = render(
      <BookerStrip
        today={TODAY}
        days={["2026-08-13", "2026-08-14", "2026-08-15"]}
        activeDay={null}
        zone={ZONE}
        onSelect={vi.fn()}
      />,
    );
    expect(container.querySelectorAll("[data-day-gap]")).toHaveLength(0);
  });

  // AA contrast, caught by axe against the running booker. Graphite at 70%
  // opacity over the sky fill measures about 3.7:1, which fails AA at 10 and
  // 11px. The two small lines are quietened with a colour token instead, and the
  // selected chip carries no opacity at all. Only the SELECTED chip fails, which
  // is the state a spot check is least likely to have open, so it gets a test.
  it("quietens the small chip lines with a colour, never opacity", () => {
    render(
      <BookerStrip
        today={TODAY}
        days={["2026-08-13", "2026-08-14"]}
        activeDay={"2026-08-13"}
        zone={ZONE}
        onSelect={vi.fn()}
      />,
    );

    const chips = screen.getAllByRole("button");
    const selected = chips.find((c) => c.getAttribute("aria-pressed") === "true")!;
    const unselected = chips.find((c) => c.getAttribute("aria-pressed") === "false")!;
    for (const chip of [selected, unselected]) {
      for (const line of chip.querySelectorAll("span")) {
        expect(line.className).not.toMatch(/\bopacity-\d+\b/);
      }
    }
    // The quiet lines on an unselected chip still read as secondary.
    expect(unselected.querySelector("span")!.className).toContain("text-fg-muted");
  });

  it("marks the active day pressed and reports a press by its date", async () => {
    const onSelect = vi.fn();
    render(
      <BookerStrip
        today={TODAY}
        days={["2026-08-13", "2026-08-14"]}
        activeDay={"2026-08-14"}
        zone={ZONE}
        onSelect={onSelect}
      />,
    );

    const chips = screen.getAllByRole("button");
    expect(chips[0].getAttribute("aria-pressed")).toBe("false");
    expect(chips[1].getAttribute("aria-pressed")).toBe("true");
    chips[0].click();
    expect(onSelect).toHaveBeenCalledWith("2026-08-13");
  });
});

// #252: the cold-case loading treatment. The strip area shows a branded skeleton
// (not a blank gap, not a bare spinner) while availability is in flight, and the
// pulse stops under prefers-reduced-motion. #1336 keeps the placeholder chips
// (they show the shape of what is coming) and adds the bobbing dots beside the
// loading line in the times panel, which is where the working signal now lives.
describe("BookerStripSkeleton (#252)", () => {
  it("renders as many placeholder chips as days are expected, hidden from assistive tech", () => {
    const { container } = render(<BookerStripSkeleton skeletonClass="bg-fg/10" count={4} />);
    const chips = container.querySelectorAll("[data-skeleton-chip]");
    expect(chips).toHaveLength(4);
    expect(container.querySelector("[aria-hidden='true']")).not.toBeNull();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("honors prefers-reduced-motion (pulse disabled) on every placeholder", () => {
    const { container } = render(<BookerStripSkeleton skeletonClass="bg-fg/10" count={4} />);
    const chips = container.querySelectorAll("[data-skeleton-chip]");
    chips.forEach((chip) => {
      expect(chip.className).toContain("animate-pulse");
      expect(chip.className).toContain("motion-reduce:animate-none");
    });
  });
});
