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
// The tier drop panel's reads are pinned in tier-drops-load.test.ts; here the
// page is driven through the loader's two outcomes, a report and a throw.
const tierDrops = vi.hoisted(() => ({ loadTierDropReport: vi.fn() }));
vi.mock("@/lib/admin/tier-drops-load", () => tierDrops);

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

const tally = (lost = 0, none = 0, unrecorded = 0) => ({
  "lost-at-confirm": lost,
  "nothing-on-show": none,
  "not-recorded": unrecorded,
  total: lost + none + unrecorded,
});
const quietReport = () => ({
  counts: { week: tally(), month: tally(), recent: [], unreadableStamps: 0 },
  booked: { week: 120, month: 635 },
});

beforeEach(() => {
  vi.clearAllMocks();
  env.consoleHiddenFor.mockReturnValue(false);
  dbState.users = [{ id: "u1", name: "Aria Agent", email: "aria@trypennie.com", org_id: "o1" }];
  dbState.bookings = [];
  dbState.bookingsSelects = [];
  dbState.bookingsFilters = [];
  tierDrops.loadTierDropReport.mockResolvedValue(quietReport());
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

// 2026-10-02: a tier drop no longer pages, so this panel is where it is seen.
describe("the tier drop panel", () => {
  it("counts each cause against the routed bookings, and links each drop", async () => {
    tierDrops.loadTierDropReport.mockResolvedValue({
      counts: {
        week: tally(1, 1),
        month: tally(5, 3, 1),
        recent: [
          {
            id: "d6d216f6",
            createdAt: "2026-10-01T21:07:26Z",
            cause: "lost-at-confirm",
            requestedLabel: "High",
            bookedLabel: "Medium",
            bucketCode: "211",
          },
        ],
        unreadableStamps: 0,
      },
      booked: { week: 120, month: 635 },
    });
    render(await RecentRoutingPage());

    expect(screen.getByText("Tier drops")).toBeTruthy();
    const lost = screen.getByText(/last opening was taken before they confirmed/).closest("tr")!;
    expect(lost.textContent).toContain("1");
    expect(lost.textContent).toContain("5");
    const total = screen.getByText("Dropped a tier").closest("tr")!;
    expect(total.textContent).toContain("2 of 120");
    expect(total.textContent).toContain("9 of 635");
    // Not recorded is drawn because the month holds one.
    expect(screen.getByText("Not recorded").closest("tr")).toBeTruthy();
    expect(screen.getByText("High to Medium")).toBeTruthy();
    const open = screen.getAllByRole("link").find((a) => a.getAttribute("href")?.includes("d6d216f6"));
    expect(open).toBeTruthy();
    expect(tierDrops.loadTierDropReport).toHaveBeenCalledWith(expect.anything(), "o1", expect.any(Number));
  });

  it("says a quiet month in words, against the bookings it looked at", async () => {
    render(await RecentRoutingPage());
    expect(screen.getByText(/No lead has dropped a tier in the last 30 days, out of 635 routed bookings/)).toBeTruthy();
    expect(screen.queryByText("Dropped a tier")).toBeNull();
  });

  it("draws an unreadable notice, never a quiet month, when the read fails", async () => {
    tierDrops.loadTierDropReport.mockRejectedValue(new Error("read failed"));
    render(await RecentRoutingPage());
    expect(screen.getByText(/tier drops could not be read/)).toBeTruthy();
    expect(screen.queryByText(/No lead has dropped a tier/)).toBeNull();
    // and the rest of the page still draws
    expect(screen.getByText(/No bookings yet/)).toBeTruthy();
  });
});
