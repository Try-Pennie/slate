// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

// The viewer's zone is the one input the times read from the world, so the test
// sets it rather than inheriting whatever machine runs the suite.
vi.mock("@/lib/booking/timezones", () => ({ deviceTimeZone: () => "America/New_York" }));

import { StrandedCallsCard } from "@/components/admin/StrandedCallsCard";
import type { BulkReassignActionableItem } from "@/lib/booking/bulk-reassign";

// #3595: the agent page's standing list of the calls the last coverage sweep could
// not place. It sits at the top of the page (Dan's design round, 2026-10-21), so it
// renders only when there is trouble: no card on a healthy day, and a failed read is
// its own state, never drawn as an empty list (L10).

afterEach(cleanup);

const call = (over: Partial<BulkReassignActionableItem> = {}): BulkReassignActionableItem => ({
  bookingId: "b1",
  status: "unplaceable",
  detail: "No other advisor was free at this time",
  startsAt: "2026-10-23T14:00:00Z",
  attendeeName: "Marisol Ortega",
  ...over,
});

describe("StrandedCallsCard (#3595)", () => {
  it("lists each call with its date and time, the reason and a Place by hand link", () => {
    render(
      <StrandedCallsCard
        agentName="Robert Bekele"
        state={{
          kind: "read",
          calls: [
            call(),
            call({ bookingId: "b2", attendeeName: "Luis Carvalho", startsAt: "2026-10-27T20:00:00Z", status: "failed", detail: "The move failed partway" }),
          ],
          moves: ["2026-10-11T23:57:00Z"],
        }}
      />,
    );
    expect(screen.getByText("Couldn't place (2)")).toBeTruthy();
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    // The date as well as the time: a standing list spans days.
    expect(within(rows[0]).getByText("Fri, Oct 23, 10:00am EDT")).toBeTruthy();
    expect(within(rows[0]).getByText("No other advisor was free at this time")).toBeTruthy();
    expect(within(rows[0]).getByRole("link", { name: "Place by hand" }).getAttribute("href")).toBe(
      "/admin/bookings/b1",
    );
    expect(within(rows[1]).getByText(/Luis Carvalho/)).toBeTruthy();
    expect(within(rows[1]).getByRole("link", { name: "Place by hand" }).getAttribute("href")).toBe(
      "/admin/bookings/b2",
    );
  });

  it("says which move left them and when", () => {
    render(
      <StrandedCallsCard agentName="Robert" state={{ kind: "read", calls: [call()], moves: ["2026-10-11T23:57:00Z"] }} />,
    );
    expect(screen.getByText(/Left by the move on/).textContent).toBe("Left by the move on Sun, Oct 11, 7:57pm EDT");
  });

  it("names how many moves left them when more than one did, and when the latest ran", () => {
    render(
      <StrandedCallsCard
        agentName="Robert"
        state={{ kind: "read", calls: [call()], moves: ["2026-10-14T13:00:00Z", "2026-10-11T23:57:00Z"] }}
      />,
    );
    expect(screen.getByText(/Left by 2 moves/).textContent).toBe("Left by 2 moves, the latest on Wed, Oct 14, 9:00am EDT");
  });

  // The top of the page is for trouble. A permanent "nothing is waiting" card would sit
  // above everything else on every healthy visit, so the healthy state is no card.
  it("renders nothing when no call is waiting", () => {
    const { container } = render(
      <StrandedCallsCard agentName="Robert" state={{ kind: "read", calls: [], moves: [] }} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("says the list could not be read, never an empty list, when the read failed", () => {
    render(<StrandedCallsCard agentName="Robert Bekele" state={{ kind: "unreadable" }} />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/could not check/i);
    expect(alert.textContent).toMatch(/Robert Bekele/);
    expect(screen.queryByText(/Couldn't place/)).toBeNull();
    expect(screen.queryByRole("listitem")).toBeNull();
  });
});
