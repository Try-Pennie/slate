// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// Access guard + render for the booking-API outcome panel (#418):
// unauthenticated to /login, below-admin deny, OOO-only divert, an admin sees the
// mix, and a read error surfaces loudly instead of reading as "no traffic". Real
// canEditOrgSettings is exercised; auth, redirect, the launch flag, the DB client,
// and the header chrome are mocked.
const auth = vi.hoisted(() => ({ currentUser: vi.fn() }));
const env = vi.hoisted(() => ({ consoleHiddenFor: vi.fn(() => false) }));
const rpc = vi.hoisted(() => vi.fn());
// #2717: the api_caller_seen read, as `.from(t).select(c).limit(n)`.
const seenRead = vi.hoisted(() => vi.fn(async () => ({ data: [] as unknown[], error: null as { message: string } | null })));
const from = vi.hoisted(() => vi.fn(() => ({ select: () => ({ limit: seenRead }) })));
const admin = vi.hoisted(() => ({ supabaseAdmin: vi.fn(() => ({ rpc, from })) }));
const redirect = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
);

vi.mock("@/lib/auth", () => auth);
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("@/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/env")>()),
  consoleHiddenFor: env.consoleHiddenFor,
}));
vi.mock("@/lib/supabase/admin", () => admin);
vi.mock("@/components/AppHeader", () => ({ AppHeader: () => null }));

import BookingOutcomesPage from "./page";

const ADMIN = { id: "ad1", role: "admin", org_id: "o1", email: "a@x", theme_preference: null, bookable: false, avatar_url: null };

beforeEach(() => {
  vi.clearAllMocks();
  env.consoleHiddenFor.mockReturnValue(false);
  seenRead.mockResolvedValue({ data: [], error: null });
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

// #2717: which host each booking API key has authenticated from, so a rotation that
// broke a partner is visible the same hour. Read only.
describe("BookingOutcomesPage caller sightings", () => {
  const MIX = { data: { by_outcome: {}, by_error: {} }, error: null };
  const HOUR = 60 * 60_000;

  it("says trypennie's key has never authenticated when there is no row", async () => {
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    rpc.mockResolvedValue(MIX);
    render(await BookingOutcomesPage());
    expect(from).toHaveBeenCalledWith("api_caller_seen");
    expect(screen.getByText(/trypennie's key has never authenticated/i)).toBeTruthy();
  });

  it("shows each host a key was seen from, and a proven production key as proven", async () => {
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    rpc.mockResolvedValue(MIX);
    const recent = new Date(Date.now() - 2 * HOUR).toISOString();
    seenRead.mockResolvedValue({
      data: [
        { caller: "trypennie", host_kind: "production", last_seen_at: recent, method: "GET", origin: "https://trypennie.com" },
        { caller: "trypennie", host_kind: "localhost", last_seen_at: recent, method: "GET", origin: "http://localhost:3000" },
        { caller: "regal", host_kind: "unstated", last_seen_at: recent, method: "DELETE", origin: null },
      ],
      error: null,
    });
    render(await BookingOutcomesPage());
    expect(screen.getByText("https://trypennie.com")).toBeTruthy();
    expect(screen.getByText("http://localhost:3000")).toBeTruthy();
    expect(screen.getByText(/last authenticated from their production site \(https:\/\/trypennie\.com\)/i)).toBeTruthy();
    expect(screen.queryByText(/never authenticated/i)).toBeNull();
  });

  it("surfaces an unreadable table rather than reading it as never seen", async () => {
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    rpc.mockResolvedValue(MIX);
    seenRead.mockResolvedValue({ data: null as unknown as unknown[], error: { message: "relation api_caller_seen does not exist" } });
    render(await BookingOutcomesPage());
    expect(screen.getByText(/Could not read which keys have authenticated/i)).toBeTruthy();
    expect(screen.queryByText(/never authenticated/i)).toBeNull();
  });
});
