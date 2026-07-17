// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// Access guard + render for the stuck-drain diagnostics page (#517):
// unauthenticated to /login, below-admin gets the deny notice, the OOO-only
// launch flag diverts, an admin sees the wedged rows, and a read error surfaces
// loudly instead of a false all-clear. Real canEditOrgSettings is exercised; auth,
// redirect, the launch flag, the DB client, and the header chrome are mocked.
const auth = vi.hoisted(() => ({ currentUser: vi.fn() }));
const env = vi.hoisted(() => ({ oooOnlyFor: vi.fn(() => false) }));
const admin = vi.hoisted(() => ({ supabaseAdmin: vi.fn() }));
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

import StuckDrainPage from "./page";

const ADMIN = { id: "ad1", role: "admin", org_id: "o1", email: "a@x", theme_preference: null, bookable: false, avatar_url: null };

/** Chainable, awaitable fake query builder that resolves to a single result. */
function chain(result: { data: unknown[] | null; error: { message: string } | null }) {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "gte", "order", "limit"]) b[m] = () => b;
  b.then = (resolve: (r: typeof result) => unknown) => resolve(result);
  return b;
}

function mockDb(byTable: Record<string, { data: unknown[] | null; error: { message: string } | null }>) {
  admin.supabaseAdmin.mockReturnValue({
    from: (t: string) => chain(byTable[t] ?? { data: [], error: null }),
  });
}

const outboxRow = {
  id: "ob-1",
  booking_id: "bk-9",
  action: "reschedule",
  status: "pending",
  attempts: 7,
  last_error: "google 503 timeout",
  next_attempt_at: "2026-07-17T18:05:00Z",
  created_at: "2026-07-17T17:00:00Z",
  updated_at: "2026-07-17T18:00:00Z",
};
const reservationRow = {
  id: "rs-1",
  idempotency_key: "idem-xyz",
  status: "pending",
  attempts: 50,
  last_error: null,
  next_attempt_at: null,
  created_at: "2026-07-16T10:00:00Z",
  updated_at: "2026-07-17T09:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  env.oooOnlyFor.mockReturnValue(false);
});

describe("StuckDrainPage", () => {
  it("redirects an unauthenticated visitor to /login", async () => {
    auth.currentUser.mockResolvedValueOnce(null);
    await expect(StuckDrainPage()).rejects.toThrow(/NEXT_REDIRECT:\/login/);
  });

  it("shows the deny notice to a below-admin caller", async () => {
    auth.currentUser.mockResolvedValueOnce({ ...ADMIN, role: "manager" });
    render(await StuckDrainPage());
    expect(screen.getByText(/admin account to view stuck deliveries/i)).toBeTruthy();
  });

  it("diverts to /admin/ooo while the OOO-only flag is on", async () => {
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    env.oooOnlyFor.mockReturnValueOnce(true);
    await expect(StuckDrainPage()).rejects.toThrow(/NEXT_REDIRECT:\/admin\/ooo/);
  });

  it("lists the wedged rows for an admin, flagging the given-up one", async () => {
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    mockDb({
      booking_outbox: { data: [outboxRow], error: null },
      booking_reservations: { data: [reservationRow], error: null },
    });
    render(await StuckDrainPage());
    expect(screen.getByText(/2 stuck deliveries/i)).toBeTruthy();
    expect(screen.getByText("reschedule")).toBeTruthy();
    expect(screen.getByText("bk-9")).toBeTruthy();
    expect(screen.getByText(/google 503 timeout/i)).toBeTruthy();
    expect(screen.getByText("idem-xyz")).toBeTruthy();
    // The reservation is at the give-up cap, so it is flagged rather than shown as a bare count.
    expect(screen.getByText(/50 · gave up/i)).toBeTruthy();
  });

  it("shows an empty state when nothing is wedged", async () => {
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    mockDb({
      booking_outbox: { data: [], error: null },
      booking_reservations: { data: [], error: null },
    });
    render(await StuckDrainPage());
    expect(screen.getByText(/Nothing wedged/i)).toBeTruthy();
    expect(screen.getByText(/No deliveries are stuck/i)).toBeTruthy();
  });

  it("surfaces a read error loudly instead of a false all-clear", async () => {
    auth.currentUser.mockResolvedValueOnce(ADMIN);
    mockDb({
      booking_outbox: { data: null, error: { message: "column attempts does not exist" } },
      booking_reservations: { data: [], error: null },
    });
    render(await StuckDrainPage());
    expect(screen.getByText(/Could not read the drain tables/i)).toBeTruthy();
    expect(screen.getByText(/column attempts does not exist/i)).toBeTruthy();
  });
});
