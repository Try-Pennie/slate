// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// #2660: the recent routing page keeps TEST bookings out of its read.
//
// A stranger's booking on the public test bucket is a real row assigned to the
// smoke test agent, and before cutover the canary's bookings are most of the
// table. Neither is a routing decision worth reading, so the page reads through
// the bucket join and asks for real bookings only (`bookings` has no flag of its
// own). The roster read deliberately still includes the test agents (#1914):
// the name map and the bookings must agree about who exists, and that holds
// either way.
//
// This page had no test file at all, which is why the read's shape is pinned
// here rather than left to a source scan: a filter on a select string is exactly
// the line that goes missing in a refactor with nothing to say so.

const auth = vi.hoisted(() => ({ currentUser: vi.fn() }));
const env = vi.hoisted(() => ({ consoleHiddenFor: vi.fn(() => false) }));
const redirect = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
);

const dbState = vi.hoisted(() => ({
  users: [] as unknown[],
  bookings: [] as unknown[],
  /** What the bookings read asked for: its projection and its equality filters. */
  bookingsSelects: [] as string[],
  bookingsFilters: [] as [string, unknown][],
}));

const from = vi.hoisted(() =>
  vi.fn((table: string) => {
    const q: Record<string, unknown> = {
      select: (projection: string) => {
        if (table === "bookings") dbState.bookingsSelects.push(projection);
        return q;
      },
      eq: (col: string, value: unknown) => {
        if (table === "bookings") dbState.bookingsFilters.push([col, value]);
        return q;
      },
      order: () => q,
      limit: () => q,
      then: (res: (v: { data: unknown; error: unknown }) => void) =>
        res({ data: table === "users" ? dbState.users : dbState.bookings, error: null }),
    };
    return q;
  }),
);

vi.mock("@/lib/auth", () => auth);
vi.mock("@/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/env")>()),
  ...env,
}));
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from }) }));

import RecentRoutingPage from "./page";

const realBooking = () => ({
  id: "b-real",
  attendee_name: "Lead Person",
  attendee_email: "lead@example.com",
  attendee_phone: null,
  starts_at: "2026-09-10T14:00:00Z",
  assigned_user_id: "u1",
  status: "confirmed",
  routing_trace: {
    bucket_code: "411",
    bucket_id: "bkt-411",
    considered: ["u1"],
    chosen_user_id: "u1",
    fallback_applied: false,
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  env.consoleHiddenFor.mockReturnValue(false);
  dbState.users = [{ id: "u1", name: "Aria Agent", email: "aria@trypennie.com", org_id: "o1" }];
  dbState.bookings = [];
  dbState.bookingsSelects = [];
  dbState.bookingsFilters = [];
  auth.currentUser.mockResolvedValue({
    id: "m1",
    role: "manager",
    org_id: "o1",
    email: "m@trypennie.com",
  });
});

describe("RecentRoutingPage guards", () => {
  it("sends an unauthenticated visitor to /login", async () => {
    auth.currentUser.mockResolvedValueOnce(null);
    await expect(RecentRoutingPage()).rejects.toThrow(/NEXT_REDIRECT:\/login/);
  });

  it("shows the deny notice to a below-manager caller", async () => {
    auth.currentUser.mockResolvedValueOnce({ id: "a1", role: "agent", org_id: "o1" });
    render(await RecentRoutingPage());
    expect(screen.getByText(/manager or admin/i)).toBeTruthy();
  });
});

describe("the recent routing read keeps test bookings out (#2660)", () => {
  it("joins the bucket and asks for real bookings only, scoped to the org", async () => {
    dbState.bookings = [realBooking()];
    render(await RecentRoutingPage());

    expect(dbState.bookingsSelects).toHaveLength(1);
    expect(dbState.bookingsSelects[0]).toContain("buckets!inner(is_test)");
    expect(dbState.bookingsFilters).toContainEqual(["buckets.is_test", false]);
    expect(dbState.bookingsFilters).toContainEqual(["org_id", "o1"]);
  });

  // The control in the same fixture: a real booking the read returns is drawn,
  // with its agent named from the roster, so the assertions above cannot pass on
  // a page that stopped drawing the table.
  it("still draws a real booking with its agent named", async () => {
    dbState.bookings = [realBooking()];
    render(await RecentRoutingPage());

    expect(screen.getByText(/Lead Person/)).toBeTruthy();
    expect(screen.getByText(/Aria Agent/)).toBeTruthy();
    expect(screen.getByText(/How the last 1 bookings routed/)).toBeTruthy();
  });

  it("says so when the read returns nothing, rather than drawing a blank", async () => {
    render(await RecentRoutingPage());
    expect(screen.getByText(/No bookings yet/)).toBeTruthy();
  });
});
