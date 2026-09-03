// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// Access guard for the admin health page (#676): unauthenticated visitors are
// redirected to /login, and a signed-in agent (below manager) gets the deny
// notice instead of the page. Real canManageAgents is exercised; only auth
// and the navigation redirect are mocked.
//
// #1767 rebuilt the page body, and the rest of this file covers that: the page
// now states what it CHECKED rather than only what is wrong, so a healthy fleet
// produces a page worth reading instead of an empty one. The three-way
// distinction (measured healthy / measured bad / could not measure) lives on
// every row, and the unreadable half of it is covered in page-unreadable.test.tsx.
const auth = vi.hoisted(() => ({ currentUser: vi.fn() }));
const env = vi.hoisted(() => ({ oooOnlyFor: vi.fn(() => false) }));
const admin = vi.hoisted(() => ({ supabaseAdmin: vi.fn() }));
const heartbeat = vi.hoisted(() => ({ readAllHeartbeatMs: vi.fn(async () => ({})) }));
const redirect = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
);

vi.mock("@/lib/auth", () => auth);
vi.mock("next/navigation", () => ({ redirect, notFound: vi.fn() }));
vi.mock("@/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/env")>()),
  oooOnlyFor: env.oooOnlyFor,
}));
vi.mock("@/lib/supabase/admin", () => admin);
vi.mock("@/lib/monitor/heartbeat", () => heartbeat);

import AdminPage from "./page";
import { LANE_STALE_BOUNDS_MS } from "@/lib/monitor/health";

const SUPER_ADMIN = {
  id: "s1",
  role: "super_admin",
  org_id: "o1",
  email: "s@x.com",
  name: "Sam",
  theme_preference: null,
  bookable: false,
  avatar_url: null,
};

type Result = { data: unknown; error: { message: string } | null };

/**
 * Two bookable agents out of seven, both holding a live push watch, both syncing
 * cleanly. The three numbers are deliberately DIFFERENT (2, 7, 2) so a test that
 * counts how often the push figure is printed cannot be answered by the roster
 * figure sitting next to it.
 */
function healthyTables(): Record<string, Result> {
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const users = Array.from({ length: 7 }, (_, i) => ({
    id: `u${i}`,
    org_id: "o1",
    name: `Agent ${i}`,
    email: `a${i}@x.com`,
    role: "agent",
    bookable: i < 2,
    attributes: {},
    deactivated_at: null,
    manager_id: null,
    is_test: false,
  }));
  return {
    users: { data: users, error: null },
    agent_calendars: {
      data: users
        .filter((u) => u.bookable)
        .map((u) => ({
          user_id: u.id,
          watch_expiration: future,
          consecutive_failures: 0,
          last_success_at: new Date().toISOString(),
          last_sync_error: null,
          watch_consecutive_failures: 0,
          watch_last_success_at: new Date().toISOString(),
          watch_last_error: null,
        })),
      error: null,
    },
  };
}

function mockDb(overrides: Record<string, Result> = {}) {
  const byTable = { ...healthyTables(), ...overrides };
  admin.supabaseAdmin.mockReturnValue({
    from: (table: string) => {
      const result = byTable[table] ?? { data: [], error: null };
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "not", "gte", "lte", "order", "limit", "range"]) {
        b[m] = () => b;
      }
      b.maybeSingle = () => b;
      b.single = b.maybeSingle;
      b.then = (resolve: (r: Result) => unknown) => Promise.resolve(result).then(resolve);
      return b;
    },
  });
}

/** Every lane stamped `agoMs` ago, with per-lane overrides. */
function lanesStampedAgo(agoMs = 0, overrides: Record<string, number | null> = {}) {
  const now = Date.now();
  const map: Record<string, number | null> = {};
  for (const lane of Object.keys(LANE_STALE_BOUNDS_MS)) map[lane] = now - agoMs;
  return { ...map, ...overrides };
}

const pageText = () => document.body.textContent ?? "";

beforeEach(() => {
  vi.clearAllMocks();
  env.oooOnlyFor.mockReturnValue(false);
  auth.currentUser.mockResolvedValue(SUPER_ADMIN);
  mockDb();
  heartbeat.readAllHeartbeatMs.mockResolvedValue(lanesStampedAgo());
});

describe("AdminPage guard", () => {
  it("redirects an unauthenticated visitor to /login", async () => {
    auth.currentUser.mockResolvedValueOnce(null);
    await expect(AdminPage()).rejects.toThrow(/NEXT_REDIRECT:\/login/);
  });

  it("shows the deny notice to a signed-in agent instead of the roster", async () => {
    auth.currentUser.mockResolvedValueOnce({ id: "a1", role: "agent", org_id: "o1" });
    render(await AdminPage());
    expect(screen.getByText(/manager or admin account to open this page/i)).toBeTruthy();
  });
});

// #1767: the page's own freshness claim. The roster, the calendar rows and the
// lane heartbeats are read at request time, so they really are seconds old. The
// calendar-sync verdict is not: it reads `consecutive_failures` and
// `last_success_at`, columns the sync and watch lanes write, so it is only as
// fresh as those lanes' last successful tick. A headline taken from the render
// clock would claim the whole page was verified seconds ago while one row of it
// was an hour stale, which is the page telling a reassuring lie about the one
// thing it exists to report.
describe("the health page's derived headline (#1767)", () => {
  it("says everything checked out just now when every input is fresh", async () => {
    render(await AdminPage());
    expect(pageText()).toMatch(/Everything checked out just now/i);
  });

  it("ages the headline with the oldest input rather than the render clock", async () => {
    // The sync lane last ticked 8 minutes ago: inside its 10-minute bound, so NO
    // row turns bad and nothing else on the page moves. Only the freshness of the
    // calendar-streak columns changed, and the headline has to follow it. Off the
    // render clock this still reads "just now".
    heartbeat.readAllHeartbeatMs.mockResolvedValue(
      lanesStampedAgo(0, { sync: Date.now() - 8 * 60_000 }),
    );
    render(await AdminPage());
    expect(pageText()).toMatch(/Everything checked out 8 minutes ago/i);
    expect(pageText()).not.toMatch(/checked out just now/i);
  });

  it("does not claim everything checked out when a read could not be made", async () => {
    mockDb({ agent_calendars: { data: null, error: { message: "boom" } } });
    render(await AdminPage());
    expect(pageText()).not.toMatch(/Everything checked out/i);
    expect(pageText()).toMatch(/could not be made/i);
  });
});

describe("the health page's status rows (#1767)", () => {
  it("states each thing it checked on a healthy fleet", async () => {
    render(await AdminPage());
    for (const label of ["Fleet", "Calendar push", "Calendar sync", "Cron lanes"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    // The all-clear is a positive statement, not the absence of a warning.
    expect(pageText()).toMatch(/no agent is in a failure streak/i);
    expect(screen.getAllByText("Checked")).toHaveLength(4);
  });

  it("prints the push watch figure exactly once", async () => {
    // Defect 1: the hero said "2/2 calendars syncing" and the card below it said
    // "push 2/2 watched", both off the same `watchedCount`. Matches either
    // rendering of the ratio so the count is about the FIGURE, not the wording.
    render(await AdminPage());
    expect(pageText().match(/2\s*(?:of|\/)\s*2/g) ?? []).toHaveLength(1);
    expect(pageText()).toMatch(/2 of 2 bookable agents on push/i);
  });

  it("never describes the push watch count as calendars syncing", async () => {
    // It counts bookable agents holding a live Google push WATCH channel. It does
    // not measure whether anything is syncing; the failure streak does that.
    render(await AdminPage());
    expect(pageText()).not.toMatch(/calendars syncing/i);
  });

  it("reports the calendar rows as not measured rather than as a zero", async () => {
    mockDb({ agent_calendars: { data: null, error: { message: "boom" } } });
    render(await AdminPage());
    expect(screen.getAllByText("Not measured").length).toBeGreaterThan(0);
    expect(pageText()).not.toMatch(/0 of 2 bookable agents on push/i);
  });
});

describe("the cron lane summary (#1767)", () => {
  it("collapses nine lanes of the same age into one summary line", async () => {
    render(await AdminPage());
    const details = document.querySelector("details");
    expect(details).toBeTruthy();
    expect((details as HTMLDetailsElement).open).toBe(false);
    const summary = details?.querySelector("summary")?.textContent ?? "";
    expect(summary).toMatch(/all 9 lanes ran on time/i);
    // Nine lanes agreeing is one fact, so the summary states it once and names
    // no lane. Every lane is still there behind the disclosure.
    expect(summary).not.toMatch(/recompute/);
    for (const lane of Object.keys(LANE_STALE_BOUNDS_MS)) {
      expect(pageText()).toContain(lane);
    }
  });

  it("names a stale lane in the summary without expanding it", async () => {
    heartbeat.readAllHeartbeatMs.mockResolvedValue(
      lanesStampedAgo(0, { monitor: Date.now() - 90 * 60_000 }),
    );
    render(await AdminPage());
    const details = document.querySelector("details") as HTMLDetailsElement;
    const summary = details.querySelector("summary")?.textContent ?? "";
    expect(summary).toMatch(/monitor/);
    expect(summary).toMatch(/past its bound/i);
    expect(details.open).toBe(false);
  });

  it("names a lane with no successful tick yet in the summary", async () => {
    // `never` is a THIRD state, distinct from stale (health.ts classifyLaneHealth):
    // the heartbeat read succeeded and reported no stamp at all. A collapse that
    // only counted stale lanes would swallow it into "all 9 lanes ran on time".
    heartbeat.readAllHeartbeatMs.mockResolvedValue(
      lanesStampedAgo(0, { "bulk-reassign": null }),
    );
    render(await AdminPage());
    const details = document.querySelector("details") as HTMLDetailsElement;
    const summary = details.querySelector("summary")?.textContent ?? "";
    expect(summary).toMatch(/bulk-reassign/);
    expect(summary).toMatch(/no successful tick recorded yet/i);
    expect(summary).not.toMatch(/all 9 lanes ran on time/i);
    expect(details.open).toBe(false);
  });
});
