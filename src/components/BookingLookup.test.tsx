// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import BookingLookup from "@/components/BookingLookup";
import type { BookingSearchRow } from "@/lib/booking/search";
import { SEARCH_LIMIT } from "@/lib/booking/search-limit";
import { TEST_MODE_COPY } from "@/lib/booking/booker-copy";

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
    isTest: false,
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

  it("searches on submit and renders each match as a link to its detail page", async () => {
    const fn = mockFetch(() => ({ ok: true, json: async () => ({ bookings: ROWS }) }) as Response);
    render(<BookingLookup />);
    await userEvent.type(screen.getByRole("searchbox"), "jane@acme.co");
    await userEvent.click(screen.getByRole("button", { name: /^search$/i }));
    await waitFor(() => expect(fn).toHaveBeenCalled());
    // #3399: the term rides in the body. Cloudflare logs every request address in
    // full, so a lead's email typed here must never become part of the address.
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/admin/bookings/search");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ q: "jane@acme.co" });
    const link = (await screen.findByRole("link", { name: /jane doe/i })) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/admin/bookings/b1");
    expect(screen.getByText(/Jamie Smith/)).toBeTruthy();
  });

  // #2660: a booking on the public test bucket is a stranger's test, not a lead.
  // It stays findable (a manager cancelling one is how the issue's own evidence
  // was gathered) and is MARKED, in the one treatment reserved for test mode, so
  // it is never read as a customer. A real row carries no mark at all.
  it("marks a test booking, and only a test booking", async () => {
    const rows: BookingSearchRow[] = [
      ROWS[0]!,
      { ...ROWS[0]!, id: "b2", attendeeName: "Pat Tester", isTest: true },
    ];
    mockFetch(() => ({ ok: true, json: async () => ({ bookings: rows }) }) as Response);
    render(<BookingLookup />);
    await userEvent.type(screen.getByRole("searchbox"), "acme");
    await userEvent.click(screen.getByRole("button", { name: /^search$/i }));
    const testRow = (await screen.findByRole("link", { name: /pat tester/i })) as HTMLAnchorElement;
    const realRow = screen.getByRole("link", { name: /jane doe/i }) as HTMLAnchorElement;
    expect(testRow.textContent).toContain(TEST_MODE_COPY.label);
    expect(realRow.textContent).not.toContain(TEST_MODE_COPY.label);
    expect(testRow.querySelector(".pn-test-mode-mark")).toBeTruthy();
    expect(realRow.querySelector(".pn-test-mode-mark")).toBeNull();
  });

  it("shows an empty message when nothing matches", async () => {
    mockFetch(() => ({ ok: true, json: async () => ({ bookings: [] }) }) as Response);
    render(<BookingLookup />);
    await userEvent.type(screen.getByRole("searchbox"), "nobody");
    await userEvent.click(screen.getByRole("button", { name: /^search$/i }));
    await screen.findByText(/no bookings found for that search/i);
  });

  it("warns when the result filled the row cap (there may be more)", async () => {
    const many: BookingSearchRow[] = Array.from({ length: SEARCH_LIMIT }, (_, i) => ({
      ...ROWS[0],
      id: `b${i}`,
    }));
    mockFetch(() => ({ ok: true, json: async () => ({ bookings: many, truncated: true }) }) as Response);
    render(<BookingLookup />);
    await userEvent.type(screen.getByRole("searchbox"), "smith");
    await userEvent.click(screen.getByRole("button", { name: /^search$/i }));
    await screen.findByText(/showing the first 20/i);
  });

  it("does not warn when the result is under the cap", async () => {
    mockFetch(() => ({ ok: true, json: async () => ({ bookings: ROWS }) }) as Response);
    render(<BookingLookup />);
    await userEvent.type(screen.getByRole("searchbox"), "jane");
    await userEvent.click(screen.getByRole("button", { name: /^search$/i }));
    await screen.findByRole("link", { name: /jane doe/i });
    expect(screen.queryByText(/showing the first 20/i)).toBeNull();
  });

  it("shows an error (not empty) when the search fails", async () => {
    mockFetch(() => ({ ok: false, json: async () => ({}) }) as Response);
    render(<BookingLookup />);
    await userEvent.type(screen.getByRole("searchbox"), "jane");
    await userEvent.click(screen.getByRole("button", { name: /^search$/i }));
    await screen.findByText(/couldn't load/i);
  });
});
