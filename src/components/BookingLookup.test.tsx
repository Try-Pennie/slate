// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import BookingLookup from "@/components/BookingLookup";
import type { BookingSearchRow } from "@/lib/booking/search";

// #901: look up ANY booking (not just the recent 25) and view its history. The
// search fetches on submit, shows distinct loading/error/empty states, and each
// result row carries the #561 History toggle.

const ROWS: BookingSearchRow[] = [
  {
    id: "b1",
    attendeeName: "Jane Doe",
    attendeeEmail: "jane@acme.co",
    attendeePhone: null,
    startsAt: "2026-07-02T18:00:00Z",
    agentName: "Jamie Smith",
    status: "confirmed",
  },
];

function mockFetch(responder: (url: string) => Response) {
  const fn = vi.fn(async (url: RequestInfo | URL) => responder(String(url)));
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

beforeEach(() => vi.clearAllMocks());

describe("BookingLookup", () => {
  it("does not search until a query is submitted", () => {
    const fn = mockFetch(() => ({ ok: true, json: async () => ({ bookings: ROWS }) }) as Response);
    render(<BookingLookup />);
    expect(fn).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /search/i })).toBeTruthy();
  });

  it("searches on submit and renders each match with a History toggle", async () => {
    const fn = mockFetch(() => ({ ok: true, json: async () => ({ bookings: ROWS }) }) as Response);
    render(<BookingLookup />);
    await userEvent.type(screen.getByRole("searchbox"), "jane@acme.co");
    await userEvent.click(screen.getByRole("button", { name: /^search$/i }));
    await waitFor(() => expect(fn).toHaveBeenCalled());
    expect(fn.mock.calls[0][0]).toContain("/api/admin/bookings/search?q=jane%40acme.co");
    await screen.findByText("Jane Doe");
    expect(screen.getByText(/Jamie Smith/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /history/i })).toBeTruthy();
  });

  it("shows an empty message when nothing matches", async () => {
    mockFetch(() => ({ ok: true, json: async () => ({ bookings: [] }) }) as Response);
    render(<BookingLookup />);
    await userEvent.type(screen.getByRole("searchbox"), "nobody");
    await userEvent.click(screen.getByRole("button", { name: /^search$/i }));
    await screen.findByText(/no bookings found for that search/i);
  });

  it("shows an error (not empty) when the search fails", async () => {
    mockFetch(() => ({ ok: false, json: async () => ({}) }) as Response);
    render(<BookingLookup />);
    await userEvent.type(screen.getByRole("searchbox"), "jane");
    await userEvent.click(screen.getByRole("button", { name: /^search$/i }));
    await screen.findByText(/couldn't load/i);
  });
});
