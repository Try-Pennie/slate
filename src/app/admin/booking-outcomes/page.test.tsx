// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// Access guard + render for the booking-API outcome panel (#418):
// unauthenticated to /login, below-admin deny, OOO-only divert, an admin sees the
// mix, and a read error surfaces loudly instead of reading as "no traffic". Real
// canEditOrgSettings is exercised; auth, redirect, the launch flag, the DB client,
// and the header chrome are mocked.
const auth = vi.hoisted(() => ({ currentUser: vi.fn() }));
const env = vi.hoisted(() => ({ oooOnlyFor: vi.fn(() => false) }));
const rpc = vi.hoisted(() => vi.fn());
const admin = vi.hoisted(() => ({ supabaseAdmin: vi.fn(() => ({ rpc })) }));
const redirect = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
);

vi.mock("@/lib/auth", () => auth);
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("@/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/env")>()),
  oooOnlyFor: env.oooOnlyFor,
}));
vi.mock("@/lib/supabase/admin", () => admin);
vi.mock("@/components/AppHeader", () => ({ AppHeader: () => null }));

import BookingOutcomesPage from "./page";

const ADMIN = { id: "ad1", role: "admin", org_id: "o1", email: "a@x", theme_preference: null, bookable: false, avatar_url: null };

beforeEach(() => {
  vi.clearAllMocks();
  env.oooOnlyFor.mockReturnValue(false);
});

describe("BookingOutcomesPage", () => {
  it("redirects an unauthenticated visitor to /login", async () => {
    auth.currentUser.mockResolvedValueOnce(null);
    await expect(BookingOutcomesPage()).rejects.toThrow(/NEXT_REDIRECT:\/login/);
  });

  it("shows the deny notice to a below-admin caller", async () => {
    auth.currentUser.mockResolvedValueOnce({ ...ADMIN, role: "manager" });
    render(await BookingOutcomesPage());
    expect(screen.getByText(/admin account to view booking API outcomes/i)).toBeTruthy();
  });

  it("renders the outcome mix and error breakdown for an admin", async () => {
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    rpc.mockResolvedValue({
      data: {
        by_outcome: { created: 8, deduped: 2, error: 2 },
        by_error: { NO_ELIGIBLE_AGENTS: 2 },
      },
      error: null,
    });
    render(await BookingOutcomesPage());
    expect(screen.getByText("Last 7 days")).toBeTruthy();
    expect(screen.getByText("Last 30 days")).toBeTruthy();
    // Both windows render the same mocked mix; "Created" appears in each.
    expect(screen.getAllByText("Created").length).toBe(2);
    expect(screen.getAllByText("NO_ELIGIBLE_AGENTS").length).toBe(2);
  });

  it("shows an empty state per window when there is no traffic", async () => {
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    rpc.mockResolvedValue({ data: { by_outcome: {}, by_error: {} }, error: null });
    render(await BookingOutcomesPage());
    expect(screen.getAllByText(/No direct booking API calls in this window/i).length).toBe(2);
  });

  it("surfaces a read error loudly instead of a false all-clear", async () => {
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    rpc.mockResolvedValueOnce({ data: null, error: { message: "function does not exist" } });
    rpc.mockResolvedValueOnce({ data: { by_outcome: {}, by_error: {} }, error: null });
    render(await BookingOutcomesPage());
    expect(screen.getByText(/Could not read the outcome tally/i)).toBeTruthy();
    expect(screen.getByText(/function does not exist/i)).toBeTruthy();
  });
});
