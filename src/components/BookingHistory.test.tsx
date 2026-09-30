// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// The viewer's zone is set, never inherited from the machine running the suite (L504).
vi.mock("@/lib/booking/timezones", () => ({ deviceTimeZone: () => "America/Phoenix" }));

import BookingHistory from "@/components/BookingHistory";
import type { BookingEventView } from "@/lib/booking/event-display";

// #561 built this as an on demand panel behind a toggle. #1943 removed the
// toggle, which meant removing the client fetch with it: the page is a server
// component and the history is a server read, so the events arrive as a prop and
// the loading, error and retry states went with the fetch. What had to survive
// is that an UNREADABLE history is a different screen from an empty one.

const EVENTS: BookingEventView[] = [
  {
    id: "e-new",
    at: "2026-07-04T13:00:00Z",
    action: "reassigned",
    actionLabel: "Reassigned",
    who: "Dan Wright, acting as Jo Lee",
    reason: "Coverage (agent unavailable)",
    timeChange: null,
    agentChange: "Jo Lee → Ana Ruiz",
    lead: "2 days before the call",
  },
  {
    id: "e-old",
    at: "2026-07-01T13:00:00Z",
    action: "cancelled",
    actionLabel: "Cancelled",
    who: "Customer",
    reason: "No longer interested",
    timeChange: null,
    agentChange: null,
    lead: "4 hours after the call was due",
  },
];

beforeEach(() => vi.clearAllMocks());

describe("BookingHistory (#1943)", () => {
  // Dan: "don't hide history. there should be no toggle there. leave it open
  // like this all the time." It is rendered by the server now, so there is no
  // toggle, no fetch, no skeleton and no retry: the events arrive as a prop.
  it("shows every event with no toggle to press", () => {
    render(<BookingHistory events={EVENTS} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Reassigned")).toBeTruthy();
    expect(screen.getByText("Dan Wright, acting as Jo Lee")).toBeTruthy();
    expect(screen.getByText("Jo Lee \u2192 Ana Ruiz")).toBeTruthy();
    expect(screen.getByText("No longer interested")).toBeTruthy();
  });

  it("says how many changes there are and which way they run", () => {
    render(<BookingHistory events={EVENTS} />);
    // The order was an assumption the reader had to make, and with stamps in the
    // same minute there was nothing to infer it from.
    expect(screen.getByText(/2 changes, newest first/i)).toBeTruthy();
  });

  it("says a booking has no changes when it has none", () => {
    render(<BookingHistory events={[]} />);
    expect(screen.getByText(/no changes recorded for this booking/i)).toBeTruthy();
  });

  // The distinction the shared async states used to carry, and the one that had
  // to survive moving to the server: an unreadable history is not an empty one.
  it("says the history could not be read, rather than that nothing changed", () => {
    render(<BookingHistory events={null} />);
    expect(screen.getByText(/could not be read/i)).toBeTruthy();
    expect(screen.queryByText(/no changes recorded/i)).toBeNull();
    // And it does not look like the quiet case.
    expect(screen.getByText(/could not be read/i).className).toContain("text-error");
  });

  // #1943: three events inside one minute cannot be ordered by eye without them.
  it("shows seconds, so events in the same minute can be told apart", () => {
    render(
      <BookingHistory
        events={[
          { ...EVENTS[0], id: "a", at: "2026-07-04T13:00:05Z" },
          { ...EVENTS[1], id: "b", at: "2026-07-04T13:00:41Z" },
        ]}
      />,
    );
    const stamps = [...document.querySelectorAll("li .tabular-nums")].map((n) => n.textContent ?? "");
    expect(stamps.length).toBe(2);
    for (const stamp of stamps) expect(stamp).toMatch(/\d+:\d{2}:\d{2}/);
    // Different seconds render differently, or showing them buys nothing.
    expect(stamps[0]).not.toBe(stamps[1]);
  });

  // #1916: every time on the panel is in the viewer's zone and says which, the
  // recorded stamp and both ends of a time move alike.
  it("renders every time in the viewer's zone, labelled", () => {
    render(
      <BookingHistory
        events={[
          {
            ...EVENTS[0],
            action: "rescheduled",
            actionLabel: "Rescheduled",
            at: "2026-07-04T13:00:05Z",
            timeChange: { from: "2026-07-03T18:00:00Z", to: "2026-07-05T18:00:00Z" },
            agentChange: null,
          },
        ]}
      />,
    );
    expect(screen.getByText("Sat, Jul 4, 6:00:05am MST")).toBeTruthy();
    expect(screen.getByText("Fri, Jul 3, 11:00am MST")).toBeTruthy();
    expect(screen.getByText("Sun, Jul 5, 11:00am MST")).toBeTruthy();
  });

  // The left rule is ONE continuous line on the list, not a segment per entry
  // with a gap between them, which read as an artefact rather than a timeline.
  it("draws one continuous rule rather than a segment per entry", () => {
    render(<BookingHistory events={EVENTS} />);
    const list = document.querySelector("ol")!;
    expect(list.className).toContain("border-l-2");
    for (const li of document.querySelectorAll("li")) {
      expect(li.className).not.toContain("border-l");
    }
  });
});
