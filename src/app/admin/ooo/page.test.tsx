// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// Access guard for the OOO queue page (#676): unauthenticated to /login, and a
// below-manager caller gets the deny notice instead of the request queue. Real
// canManageAgents is exercised; only auth and the navigation redirect are mocked.
const auth = vi.hoisted(() => ({ currentUser: vi.fn() }));
const redirect = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
);

// #1475: the queue must actually RENDER the "manager cannot approve" explanation.
// scripts/test-ooo-core.ts proves the predicate and the sentence; only mounting the
// page proves the page uses them, which is the half a static read cannot see (the
// same reason the booker copy has a parity test beside its preview).
const dbState = vi.hoisted(() => ({
  pending: [] as unknown[],
  history: [] as unknown[],
  users: [] as unknown[],
  bookings: [] as unknown[],
  /** Which ooo_requests read this is: the page runs pending, then history. Reset
   *  per test, or a later test's pending read serves the (empty) history and every
   *  absence assertion passes on a blank page. */
  oooReads: 0,
}));
const from = vi.hoisted(() =>
  vi.fn((table: string) => {
    const q: Record<string, unknown> = {
      select: () => q,
      eq: () => q,
      in: () => q,
      gte: () => q,
      lte: () => q,
      is: () => q,
      lt: () => q,
      gt: () => q,
      neq: () => q,
      not: () => q,
      or: () => q,
      order: () => q,
      limit: () => q,
      range: () => q,
      single: async () => ({ data: { default_timezone: "America/New_York" } }),
      maybeSingle: async () => ({ data: null }),
      then: (res: (v: { data: unknown; error: null }) => void) => {
        // The page runs the pending query before the history query, so serve them
        // in call order rather than guessing from the table name (both read
        // ooo_requests).
        if (table === "ooo_requests") {
          const next = dbState.oooReads++ === 0 ? dbState.pending : dbState.history;
          return res({ data: next, error: null });
        }
        return res({
          data: table === "users" ? dbState.users : table === "bookings" ? dbState.bookings : [],
          error: null,
        });
      },
    };
    return q;
  }),
);

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from }) }));
vi.mock("@/components/AppHeader", () => ({ AppHeader: () => null }));
// The insights read is paged separately; an empty history keeps this test about
// the badge rather than about the analytics band.
vi.mock("@/lib/ooo/history-load", () => ({ loadOrgOooHistory: async () => [] }));

vi.mock("@/lib/auth", () => auth);
vi.mock("next/navigation", () => ({ redirect }));

import OooQueuePage from "./page";

const props = { searchParams: Promise.resolve({}) };

beforeEach(() => vi.clearAllMocks());

describe("OooQueuePage guard", () => {
  it("redirects an unauthenticated visitor to /login", async () => {
    auth.currentUser.mockResolvedValueOnce(null);
    await expect(OooQueuePage(props)).rejects.toThrow(/NEXT_REDIRECT:\/login/);
  });

  it("shows the deny notice to a below-manager caller", async () => {
    auth.currentUser.mockResolvedValueOnce({ id: "a1", role: "agent", org_id: "o1" });
    render(await OooQueuePage(props));
    expect(screen.getByText(/manager or admin account to review time off/i)).toBeTruthy();
  });
});

// #1477: the failed calendar steps used to live in a title attribute, so the
// page named a problem and offered no way to read it on a phone, to a screen
// reader, or from the keyboard. A static read of the component cannot tell a
// tooltip from text, so this mounts the real thing and asserts on the DOM.
import { FailedSteps } from "./FailedSteps";
import { describeEffects } from "@/lib/ooo/effect-copy";

describe("FailedSteps (#1477)", () => {
  const steps = describeEffects({
    manager_event: "ok",
    agent_event:
      'failed: Error: events.insert failed: 503 {"error":{"errors":[{"reason":"backendError"}],"code":503}}',
    busy_block: "ok (slate fallback)",
  }).failed;

  it("names the failed step, and its reason, as text on the page", () => {
    const { container } = render(<FailedSteps steps={steps} />);

    expect(container.textContent).toMatch(
      /not in place: the event on the agent.s own calendar/i,
    );
    expect(container.textContent).toMatch(/503 backendError/);
  });

  it("puts nothing in a tooltip, which is unreachable without a pointer", () => {
    const { container } = render(<FailedSteps steps={steps} />);

    expect(container.querySelector("[title]")).toBeNull();
  });

  it("says nothing about the steps that are in place", () => {
    const { container } = render(<FailedSteps steps={steps} />);

    expect(container.textContent).not.toMatch(/manager.s OOO calendar entry/i);
  });

  it("renders nothing at all when every step landed", () => {
    const { container } = render(<FailedSteps steps={[]} />);

    expect(container.textContent).toBe("");
  });
});

// #1475: a request whose manager of record cannot approve is EXPLAINED on the
// queue, not left looking like an ordinary pending request with a slow approver.
//
// The wording itself is tested in scripts/test-ooo-core.ts against the builder.
// What this adds is that the page really calls that builder, and really decides
// with the shared predicate: without it the page could drift back to an inline
// sentence, or to its own role test, and both node suites would stay green.
describe("OooQueuePage: manager of record who cannot approve (#1475)", () => {
  const requestRow = (managerId: string | null) => ({
    id: "r1",
    org_id: "o1",
    user_id: "u-agent",
    manager_id: managerId,
    status: "pending",
    starts_at: "2026-09-01T13:00:00Z",
    ends_at: "2026-09-01T21:00:00Z",
    display_tz_id: "America/New_York",
    display_tz_label: "ET",
    all_day: false,
    reason: "Vacation",
    notes: null,
    rejection_note: null,
    decided_by: null,
    decided_at: null,
    cancelled_at: null,
    side_effects: {},
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
  });
  const person = (id: string, role: string, name: string, managerId: string | null = null) => ({
    id,
    name,
    email: `${id}@trypennie.com`,
    role,
    manager_id: managerId,
  });

  beforeEach(() => {
    dbState.oooReads = 0;
    dbState.history = [];
    dbState.bookings = [];
    auth.currentUser.mockResolvedValue({
      id: "u-lead",
      role: "team_lead",
      org_id: "o1",
      email: "lead@trypennie.com",
    });
  });

  it("explains that the named manager cannot approve, and names Salesforce", async () => {
    dbState.pending = [requestRow("u-agent-mgr")];
    dbState.users = [
      person("u-agent", "agent", "Aria Agent", "u-agent-mgr"),
      person("u-agent-mgr", "agent", "Andy Approver"),
    ];

    render(await OooQueuePage(props));

    expect(screen.getByText(/Manager cannot approve/i)).toBeTruthy();
    expect(screen.getByText(/Andy Approver is set as their manager of record/i)).toBeTruthy();
    expect(screen.getByText(/correct their Agent Manager in Salesforce/i)).toBeTruthy();
  });

  it("says nothing when the named manager holds a manager role", async () => {
    dbState.pending = [requestRow("u-mgr")];
    dbState.users = [
      person("u-agent", "agent", "Aria Agent", "u-mgr"),
      person("u-mgr", "manager", "Mona Manager"),
    ];

    render(await OooQueuePage(props));

    // Prove the row is actually on screen first. Without this the assertion below
    // passes just as happily on an empty queue, which is how it passed while the
    // fake was serving the wrong read.
    expect(screen.getByText(/Vacation/i)).toBeTruthy();
    expect(screen.queryByText(/Manager cannot approve/i)).toBeNull();
  });

  // The no-manager notice is a different cause and must stay its own message, and
  // must point at Salesforce rather than the agent page, which no longer offers the
  // control (#1474).
  it("keeps the no-manager notice distinct, pointing at Salesforce", async () => {
    dbState.pending = [requestRow(null)];
    dbState.users = [person("u-agent", "agent", "Aria Agent", null)];

    render(await OooQueuePage(props));

    // getAllByText: "No manager" is also a row label in the by-manager breakdown,
    // so the pill is not the only match on the page.
    expect(screen.getAllByText(/No manager/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/set their Agent Manager in Salesforce/i)).toBeTruthy();
    expect(screen.queryByText(/Manager cannot approve/i)).toBeNull();
    expect(screen.queryByText(/on the agent page/i)).toBeNull();
  });
});

// #1499: everyone is in the OOO system now, so the roster the insights measure
// against must be everyone too.
//
// "In the OOO system" used to mean "has a manager of record", which was true only
// while a request from somebody without one was REFUSED. Nine active people are
// in that state, every one of Pennie's debt managers among them, and their
// requests count in the same insights the roster sizes, so leaving them out made
// the count and the rows it promises come from two different populations (L16).
describe("OooQueuePage: the roster covers people with no manager of record (#1499)", () => {
  // The count sits in its own <span> inside the heading, so match on the whole
  // heading's text rather than a fragment that no single element carries.
  const noTimeOffHeading = () =>
    screen
      .getAllByRole("heading")
      .map((h) => h.textContent?.replace(/\s+/g, " ").trim() ?? "")
      .find((t) => /taken no time off/.test(t)) ?? "";

  const person = (id: string, role: string, name: string, managerId: string | null = null) => ({
    id,
    name,
    email: `${id}@trypennie.com`,
    role,
    manager_id: managerId,
  });

  beforeEach(() => {
    dbState.oooReads = 0;
    dbState.pending = [];
    dbState.history = [];
    dbState.bookings = [];
    auth.currentUser.mockResolvedValue({
      id: "u-lead",
      role: "team_lead",
      org_id: "o1",
      email: "lead@trypennie.com",
    });
  });

  it("counts a manager with no manager of record as somebody who has taken no time off", async () => {
    dbState.users = [
      person("u-managed", "agent", "Aria Agent", "u-mgr"),
      person("u-mgr", "manager", "Mona Manager"), // no manager of record: the live shape
    ];

    render(await OooQueuePage(props));

    // Both, not just the one with a manager. Asserting the NAME rather than the
    // count, so the assertion cannot be satisfied by a different person.
    expect(noTimeOffHeading()).toMatch(/^2 people have taken no time off/);
    expect(screen.getByText("Mona Manager")).toBeTruthy();
    expect(screen.getByText("Aria Agent")).toBeTruthy();
  });

  it("still leaves admins out, who are operators rather than part of the bookable team", async () => {
    dbState.users = [
      person("u-mgr", "manager", "Mona Manager"),
      person("u-admin", "admin", "Ada Admin"),
    ];

    render(await OooQueuePage(props));

    expect(noTimeOffHeading()).toMatch(/^1 person has taken no time off/);
    expect(screen.queryByText("Ada Admin")).toBeNull();
  });
});
