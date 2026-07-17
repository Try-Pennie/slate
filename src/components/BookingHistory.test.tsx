// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import BookingHistory from "@/components/BookingHistory";
import type { BookingEventView } from "@/lib/booking/event-display";

// #561: on-demand per-booking history. The panel fetches only when opened, shows
// distinct loading/error/empty states (via the shared AsyncList), and renders the
// who/when/why + change detail for each event.

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
    lead: "2 days before",
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
    lead: "4 hours after",
  },
];

function mockFetch(responder: (url: string) => Response) {
  const fn = vi.fn(async (url: RequestInfo | URL) => responder(String(url)));
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

beforeEach(() => vi.clearAllMocks());

describe("BookingHistory", () => {
  it("does not fetch until the toggle is opened", () => {
    const fn = mockFetch(() => ({ ok: true, json: async () => ({ events: EVENTS }) }) as Response);
    render(<BookingHistory bookingId="bk1" />);
    expect(fn).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /history/i })).toBeTruthy();
  });

  it("loads and renders each event's who/why + change on open", async () => {
    const fn = mockFetch(() => ({ ok: true, json: async () => ({ events: EVENTS }) }) as Response);
    render(<BookingHistory bookingId="bk1" />);
    await userEvent.click(screen.getByRole("button", { name: /history/i }));
    await waitFor(() => expect(fn).toHaveBeenCalled());
    expect(fn.mock.calls[0][0]).toContain("/api/admin/bookings/bk1/history");
    await screen.findByText("Reassigned");
    expect(screen.getByText("Dan Wright, acting as Jo Lee")).toBeTruthy();
    expect(screen.getByText("Jo Lee → Ana Ruiz")).toBeTruthy();
    expect(screen.getByText("No longer interested")).toBeTruthy();
  });

  it("shows an empty message when the booking has no changes", async () => {
    mockFetch(() => ({ ok: true, json: async () => ({ events: [] }) }) as Response);
    render(<BookingHistory bookingId="bk1" />);
    await userEvent.click(screen.getByRole("button", { name: /history/i }));
    await screen.findByText(/no changes recorded for this booking/i);
  });

  it("shows an error (not an empty state) when the read fails", async () => {
    mockFetch(() => ({ ok: false, json: async () => ({}) }) as Response);
    render(<BookingHistory bookingId="bk1" />);
    await userEvent.click(screen.getByRole("button", { name: /history/i }));
    await screen.findByText(/couldn't load/i);
  });
});
