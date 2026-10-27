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
const env = vi.hoisted(() => ({ consoleHiddenFor: vi.fn(() => false) }));
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
  consoleHiddenFor: env.consoleHiddenFor,
}));
vi.mock("@/lib/supabase/admin", () => admin);
vi.mock("@/lib/monitor/heartbeat", () => heartbeat);

import AdminPage from "./page";
import {
  LANE_STALE_BOUNDS_MS,
  cronLanesNote,
  laneNote,
  type LaneName,
} from "@/lib/monitor/health";

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
      for (const m of ["select", "eq", "neq", "in", "not", "gte", "lte", "order", "limit", "range"]) {
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
  env.consoleHiddenFor.mockReturnValue(false);
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

  // Dan, 2026-10-02: the Overview is an admin's page. A manager or team lead who
  // reaches /admin (an old bookmark, a back link) lands on the roster, which is
  // where their sidebar starts, rather than on a refusal.
  it.each(["manager", "team_lead"])("sends a %s to the roster instead of the Overview", async (role) => {
    auth.currentUser.mockResolvedValueOnce({ ...SUPER_ADMIN, id: "m1", role });
    await expect(AdminPage()).rejects.toThrow(/NEXT_REDIRECT:\/admin\/agents$/);
  });

  it.each(["admin", "super_admin"])("still shows the Overview to a %s", async (role) => {
    auth.currentUser.mockResolvedValueOnce({ ...SUPER_ADMIN, id: "ad1", role });
    redirect.mockClear();
    render(await AdminPage());
    expect(screen.getByText("Online booking")).toBeTruthy();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("still sends somebody the console is hidden for to time off, before anything else", async () => {
    env.consoleHiddenFor.mockReturnValueOnce(true);
    auth.currentUser.mockResolvedValueOnce({ ...SUPER_ADMIN, id: "m1", role: "manager" });
    await expect(AdminPage()).rejects.toThrow(/NEXT_REDIRECT:\/admin\/ooo$/);
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
  // #1810: the fleet line read "102 bookable of 136 agents", and the two numbers
  // counted different populations. The numerator was filtered by isActive; the
  // denominator was every non test row, offboarded people included. So the line
  // mixed people who work here with people who used to, and advertised a total
  // the roster below can never reach (L16: a count and the rows it promises come
  // from one shared predicate).
  describe("the fleet count", () => {
    const fleetLine = () => screen.getByText(/bookable of \d+ agents/).textContent;

    it("counts only people still on the roster, in both halves", async () => {
      render(await AdminPage());
      expect(fleetLine()).toBe("2 bookable of 7 agents");
    });

    it("does not move when an offboarded person is added", async () => {
      // The assertion that would have caught this: the ONLY difference between
      // the two rosters is one departed employee, and a departed employee is not
      // a staffing gap, so neither number may notice them.
      const base = healthyTables();
      const users = [
        ...(base.users.data as Record<string, unknown>[]),
        {
          id: "gone",
          org_id: "o1",
          name: "Departed Person",
          email: "gone@x.com",
          role: "agent",
          bookable: false,
          attributes: {},
          deactivated_at: "2026-08-24T00:00:00Z",
          manager_id: null,
          is_test: false,
        },
      ];
      mockDb({ users: { data: users, error: null } });
      render(await AdminPage());
      expect(fleetLine()).toBe("2 bookable of 7 agents");
    });

    it("does move when a real agent is added, so it is not simply frozen", async () => {
      // The positive control for the case above (L1): a denominator hard wired to
      // 7, or one that ignored the roster entirely, would satisfy it.
      const base = healthyTables();
      const users = [
        ...(base.users.data as Record<string, unknown>[]),
        {
          id: "new",
          org_id: "o1",
          name: "New Hire",
          email: "new@x.com",
          role: "agent",
          bookable: false,
          attributes: {},
          deactivated_at: null,
          manager_id: null,
          is_test: false,
        },
      ];
      mockDb({ users: { data: users, error: null } });
      render(await AdminPage());
      expect(fleetLine()).toBe("2 bookable of 8 agents");
    });
  });

  it("states each thing it checked on a healthy fleet", async () => {
    render(await AdminPage());
    // #1960: "Stuck deliveries" joined this list when its own route was folded
    // in. It is empty by construction, since every row it can show has already
    // fired an alert, so on a healthy day it is one more Checked.
    for (const label of [
      // #2297: the kill switch's state. A pause set by hand and visible nowhere is
      // a booker taking nothing while every other row here reads healthy (L523).
      "Online booking",
      "Fleet",
      "Calendar push",
      "Calendar sync",
      "Stuck deliveries",
      "Cron lanes",
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    // The all-clear is a positive statement, not the absence of a warning.
    expect(pageText()).toMatch(/no agent is in a failure streak/i);
    expect(pageText()).toMatch(/no delivery is stuck/i);
    expect(pageText()).toMatch(/running\. leads can book a call/i);
    expect(screen.getAllByText("Checked")).toHaveLength(6);
  });

  // #2297: the kill switch's row, and the two states that are not the ordinary
  // day. A pause set by hand is visible NOWHERE else on this page, so if this row
  // reads healthy while bookings are stopped, every other row reads healthy too and
  // the only symptom is a funnel that went quiet (L523).
  describe("the online booking row (#2297)", () => {
    it("says bookings are stopped, and marks the row as needing attention", async () => {
      mockDb({ booking_settings: { data: { public_booking_paused: true }, error: null } });
      render(await AdminPage());
      expect(pageText()).toMatch(/stopped by hand\. leads cannot book a call/i);
      expect(pageText()).not.toMatch(/running\. leads can book a call/i);
      expect(screen.getAllByText("Needs attention").length).toBeGreaterThan(0);
    });

    // The row must also carry the way OUT, because it names a state somebody has to
    // go and change and this page is where they are standing (L80).
    it("links to the screen that starts bookings again", async () => {
      mockDb({ booking_settings: { data: { public_booking_paused: true }, error: null } });
      render(await AdminPage());
      const link = screen.getByRole("link", { name: /start it again on hours/i });
      expect(link.getAttribute("href")).toBe("/admin/business-hours");
    });

    // #2699 told a manager here to ask an admin, because a manager cannot open
    // Hours. Since 2026-10-02 a manager never reaches this page (they are sent to
    // the roster, pinned in the guard tests above), so everybody who can read
    // this row can open Hours, and the pointer is unconditional.
    it("keeps the Hours pointer for an admin, who can open it", async () => {
      auth.currentUser.mockResolvedValue({ ...SUPER_ADMIN, id: "ad1", role: "admin" });
      mockDb({ booking_settings: { data: { public_booking_paused: true }, error: null } });
      render(await AdminPage());
      expect(screen.getByRole("link", { name: /start it again on hours/i })).toBeTruthy();
      expect(pageText()).toMatch(/on the hours screen/i);
      expect(pageText()).not.toMatch(/ask an admin/i);
    });

    // The third state. An unreadable setting must not draw either answer: the booker
    // REFUSES while it cannot be read, so drawing "running" here would tell an admin
    // the opposite of what leads are meeting (L530, L11).
    it("says it could not read the setting, and that leads cannot book meanwhile", async () => {
      mockDb({
        booking_settings: { data: null, error: { message: "column does not exist" } },
      });
      render(await AdminPage());
      expect(pageText()).toMatch(/could not read the setting/i);
      expect(pageText()).toMatch(/leads cannot book/i);
      expect(pageText()).not.toMatch(/running\. leads can book a call/i);
      expect(screen.getByText("Not measured")).toBeTruthy();
    });
  });

  // #1960: the three states this panel has to keep telling apart, now that it
  // shares a page with four other checks.
  describe("the stuck deliveries panel (#1960)", () => {
    it("says nothing is stuck, rather than drawing nothing", async () => {
      render(await AdminPage());
      expect(pageText()).toMatch(/no delivery is stuck/i);
      expect(screen.getByText("Stuck deliveries")).toBeTruthy();
    });

    it("lists what is wedged and flags the rows that gave up", async () => {
      mockDb({
        booking_outbox: {
          data: [
            {
              id: "ob-1",
              booking_id: "bk-1",
              action: "calendar_insert",
              status: "pending",
              attempts: 12,
              next_attempt_at: null,
              last_error: "Google said no",
              updated_at: "2026-09-01T10:00:00Z",
            },
          ],
          error: null,
        },
      });
      render(await AdminPage());
      expect(pageText()).toMatch(/1 stuck delivery/i);
      expect(pageText()).toMatch(/google said no/i);
      expect(screen.getByText("Needs attention")).toBeTruthy();
    });

    // The distinction the whole panel was written for: an empty panel and a
    // failed read must not look the same, or "nothing drawn" covers both
    // "nothing is stuck" and "we could not tell".
    it("says the drains could not be read, rather than that nothing is stuck", async () => {
      mockDb({ booking_outbox: { data: null, error: { message: "statement timeout" } } });
      render(await AdminPage());
      expect(pageText()).toMatch(/could not be read/i);
      expect(pageText()).toMatch(/not a report that nothing is stuck/i);
      expect(pageText()).not.toMatch(/no delivery is stuck/i);
      // And the ROW's verdict says so too. Without this the row reads "Checked"
      // beside a message saying it could not be checked, which is the page
      // contradicting itself in the one place somebody trusts it.
      expect(screen.getByText("Not measured")).toBeTruthy();
      expect(screen.getAllByText("Checked")).toHaveLength(5);
    });

    // The OTHER drain. Both feed one panel, and a version that read only the
    // outbox passed every assertion above, because nothing exercised
    // reservations at all: a crash recovered create could sit wedged forever
    // with the page saying nothing is stuck.
    it("lists a wedged reservation as well as a wedged outbox row", async () => {
      mockDb({
        booking_reservations: {
          data: [
            {
              id: "rs-1",
              idempotency_key: "idem-1",
              status: "pending",
              attempts: 9,
              next_attempt_at: null,
              last_error: "confirm never returned",
              updated_at: "2026-09-01T09:00:00Z",
            },
          ],
          error: null,
        },
      });
      render(await AdminPage());
      expect(pageText()).toMatch(/1 stuck delivery/i);
      expect(pageText()).toMatch(/confirm never returned/i);
    });
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

describe("the cron lane summary (#1767, always visible since #1872)", () => {
  // #1872 removed the disclosure on Dan's call. The assertions about `details`
  // and `open` are gone rather than adjusted: their whole content was the
  // collapse being reversed (L252).
  //
  // WHAT SURVIVES INTACT is the part of #1767 that was never about the collapse:
  // the summary sentence names every lane that is not ok, in the lane's own third
  // state, so a `never` lane cannot be folded into "all N lanes ran on time"
  // (L98). That is asserted below in all three cases, and it is the reason the
  // sentence stays above the list rather than being dropped as a repeat of it.
  // The COUNT is derived, like the loop below it. It was written as a literal 9 and
  // went stale the moment a tenth lane shipped (#2359), which is the failure mode
  // this repo already names elsewhere: a hand kept number beside a derived list.
  const laneCount = Object.keys(LANE_STALE_BOUNDS_MS).length;
  const allRanOnTime = new RegExp(`all ${laneCount} lanes ran on time`, "i");

  it("states every agreeing lane once, and lists every one of them", async () => {
    render(await AdminPage());
    expect(document.querySelector("details")).toBeNull();

    const text = pageText();
    expect(text).toMatch(allRanOnTime);
    for (const lane of Object.keys(LANE_STALE_BOUNDS_MS)) {
      expect(text).toContain(lane);
      // #1872: and says what it is. A bare identifier is what the page drew.
      expect(text).toContain(laneNote(lane as LaneName));
    }
  });

  it("names a stale lane in the summary, in its own state", async () => {
    heartbeat.readAllHeartbeatMs.mockResolvedValue(
      lanesStampedAgo(0, { monitor: Date.now() - 90 * 60_000 }),
    );
    render(await AdminPage());
    const text = pageText();
    expect(text).toMatch(/monitor/);
    expect(text).toMatch(/past its bound/i);
    expect(text).not.toMatch(allRanOnTime);
  });

  it("names a lane with no successful tick yet, never as stale", async () => {
    // `never` is a THIRD state, distinct from stale (health.ts classifyLaneHealth):
    // the heartbeat read succeeded and reported no stamp at all. A summary that
    // only counted stale lanes would swallow it into "all N lanes ran on time".
    heartbeat.readAllHeartbeatMs.mockResolvedValue(
      lanesStampedAgo(0, { "bulk-reassign": null }),
    );
    render(await AdminPage());
    const text = pageText();
    expect(text).toMatch(/bulk-reassign/);
    expect(text).toMatch(/no successful tick recorded yet/i);
    expect(text).not.toMatch(allRanOnTime);
  });
});

// #1872. "Basically all of this needs explanations, so he and others know what
// the terms meant." Nothing on the page said what Fleet, Calendar push, Calendar
// sync or Cron lanes were, nor bookable, on push, a failure streak, or Checked.
describe("the Health page explains its own terms (#1872)", () => {
  it("explains every row, always, with no interaction", async () => {
    render(await AdminPage());
    const text = pageText();
    // The four row labels, each with the term inside it that is not
    // self-explanatory.
    expect(text).toMatch(/Bookable means they are in the rotation/i);
    expect(text).toMatch(/On push means that subscription is live/i);
    expect(text).toMatch(/A failure streak is how many times in a row/i);
  });

  it("says what the Cron lanes row covers, and that there are jobs it does not", async () => {
    render(await AdminPage());
    // The reading gap: "all 9 lanes ran on time" is true and gives a reader no
    // way to know a tenth job exists.
    expect(pageText()).toContain(cronLanesNote());
    expect(pageText()).toMatch(/hourly roster sync, the two time off jobs and the Snowflake export/i);
  });

  it("explains the three verdict words, including that Not measured is not a pass", async () => {
    render(await AdminPage());
    const text = pageText();
    expect(text).toMatch(/Checked means Slate measured it/i);
    expect(text).toMatch(/Not measured means the reading itself failed/i);
    expect(text).toMatch(/not the same as a clean result/i);
  });

  it("explains a row even when that row is the one that could not be measured", async () => {
    mockDb({ users: { data: null, error: { message: "boom" } } });
    render(await AdminPage());
    // The reader who most needs to know what Fleet means is the one looking at it
    // having failed to measure.
    expect(pageText()).toMatch(/Everyone Slate can route a lead to/i);
  });
});
