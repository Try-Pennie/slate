// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// Access guard for the staffing-depth view (#584): unauthenticated visitors are
// redirected to /login, and a signed-in agent (below manager) gets the deny
// notice instead of the report. Real canManageAgents is exercised; only auth and
// the navigation redirect are mocked (both fire before any DB read).
const auth = vi.hoisted(() => ({ currentUser: vi.fn() }));
const redirect = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
);
const load = vi.hoisted(() => ({ loadTierDepths: vi.fn() }));

vi.mock("@/lib/auth", () => auth);
vi.mock("next/navigation", () => ({ redirect, notFound: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({}) }));
vi.mock("@/lib/routing/staffing-depth-load", () => load);
// AppHeader is an async server component RTL can't render; stub it so the report
// body (the part under test) mounts.
vi.mock("@/components/AppHeader", () => ({ AppHeader: () => null }));

import TiersPage from "./page";

beforeEach(() => vi.clearAllMocks());

describe("TiersPage guard", () => {
  it("redirects an unauthenticated visitor to /login", async () => {
    auth.currentUser.mockResolvedValueOnce(null);
    await expect(TiersPage()).rejects.toThrow(/NEXT_REDIRECT:\/login/);
  });

  // With the console OPEN: while it is hidden the console gate answers first and
  // sends everybody below super admin to /admin/ooo (#2699), so the role refusal
  // is only reachable once the flag is on.
  it("shows the deny notice to a signed-in agent instead of the report", async () => {
    const saved = process.env.AGENT_SCHEDULING_LIVE;
    process.env.AGENT_SCHEDULING_LIVE = "true";
    try {
      auth.currentUser.mockResolvedValueOnce({ id: "a1", role: "agent", org_id: "o1" });
      render(await TiersPage());
      expect(screen.getByText(/manager or admin account to view staffing depth/i)).toBeTruthy();
    } finally {
      if (saved === undefined) delete process.env.AGENT_SCHEDULING_LIVE;
      else process.env.AGENT_SCHEDULING_LIVE = saved;
    }
  });

  it("sends a signed-in agent to /admin/ooo while the console is hidden (#2699)", async () => {
    auth.currentUser.mockResolvedValueOnce({ id: "a1", role: "agent", org_id: "o1" });
    await expect(TiersPage()).rejects.toThrow(/NEXT_REDIRECT:\/admin\/ooo/);
  });
});

describe("TiersPage time-off-aware display (#738)", () => {
  const superAdmin = {
    id: "s1",
    role: "super_admin",
    org_id: "o1",
    email: "s@x.com",
    theme_preference: null,
    bookable: false,
    avatar_url: null,
  };

  it("shows roster depth, available-today depth, and the time-off detail, flagged on effective risk", async () => {
    auth.currentUser.mockResolvedValueOnce(superAdmin);
    // Roster 4 (would read OK) but 3 out today -> effective 1 (SPOF today).
    load.loadTierDepths.mockResolvedValueOnce([
      {
        code: "311",
        name: "High | Achieve",
        depth: 4,
        effectiveDepth: 1,
        outCount: 3,
        soleAgentName: null,
        hasWorkingFallback: false,
        flag: "ok",
        effectiveFlag: "spof",
        agents: [],
      },
    ]);
    render(await TiersPage());
    // The drill-down summary shows the roster count with the available-today annotation.
    const agentsSummary = screen.getByText(
      (_, el) =>
        el?.tagName === "SUMMARY" &&
        /4/.test(el.textContent ?? "") &&
        /\(1 today\)/.test(el.textContent ?? ""),
    );
    expect(agentsSummary).toBeTruthy();
    // Detail spells out roster vs available today and the time-off count.
    expect(screen.getByText(/4 on the roster/i)).toBeTruthy();
    // #744: "out today" covers both an approved Slate time-off request and an
    // agent who simply blocked their own calendar for the day.
    expect(screen.getByText(/3 out today/i)).toBeTruthy();
    // The status pill reflects the EFFECTIVE risk, not the roster-OK flag.
    expect(screen.getByText(/single point of failure/i)).toBeTruthy();
  });

  it("#740: drills down to the covering agents, linked to their admin page, marking who is out", async () => {
    auth.currentUser.mockResolvedValueOnce(superAdmin);
    load.loadTierDepths.mockResolvedValueOnce([
      {
        code: "311",
        name: "High | Achieve",
        depth: 2,
        effectiveDepth: 1,
        outCount: 1,
        soleAgentName: null,
        hasWorkingFallback: false,
        flag: "thin",
        effectiveFlag: "spof",
        agents: [
          { id: "u-mia", name: "Mia Lee", out: false },
          { id: "u-aaron", name: "Aaron Ng", out: true },
        ],
      },
    ]);
    render(await TiersPage());
    const mia = screen.getByRole("link", { name: "Mia Lee" });
    expect(mia.getAttribute("href")).toBe("/admin/agents/u-mia");
    const aaron = screen.getByRole("link", { name: "Aaron Ng" });
    expect(aaron.getAttribute("href")).toBe("/admin/agents/u-aaron");
    // The out-today agent carries the marker (exact, so the summary chip's own
    // "agent-slots out today" text cannot satisfy this assertion).
    expect(screen.getByText("(out today)")).toBeTruthy();
  });
});

// #2237: sixty bucket codes route through fifteen pools, and the six codes of a
// tier carry identical numbers by construction. The page shows the fifteen
// answers. The grouping itself is node tested; what only shows here is that the
// page really groups, and that its counts count pools.
describe("TiersPage groups the codes that share a pool", () => {
  const superAdmin = {
    id: "s1",
    role: "super_admin",
    org_id: "o1",
    email: "s@x.com",
    theme_preference: null,
    bookable: false,
    avatar_url: null,
  };

  const lowRow = (code: string) => ({
    code,
    name: `Low | Both | ${code}`,
    depth: 1,
    effectiveDepth: 1,
    outCount: 0,
    soleAgentName: "Tyler Moffett",
    hasWorkingFallback: false,
    flag: "spof",
    effectiveFlag: "spof",
    agents: [{ id: "u-tyler", name: "Tyler Moffett", out: false }],
    poolKey: "low",
    poolLabel: "Low",
  });

  it("draws ONE row for six codes, naming the pool and every code", async () => {
    auth.currentUser.mockResolvedValueOnce(superAdmin);
    const codes = ["100", "101", "102", "110", "111", "112"];
    load.loadTierDepths.mockResolvedValueOnce(codes.map(lowRow));
    const { container } = render(await TiersPage());

    expect(container.querySelectorAll("tbody tr")).toHaveLength(1);
    // The pool's name, not one of its six bucket names.
    expect(screen.getByText("Low")).toBeTruthy();
    expect(screen.getByText(codes.join(", "))).toBeTruthy();
    // And the sole agent is named once, not six times.
    expect(screen.getAllByRole("link", { name: "Tyler Moffett" })).toHaveLength(1);
  });

  it("says 'agent' when a pool rests on one, which five rows do at the real count", async () => {
    auth.currentUser.mockResolvedValueOnce(superAdmin);
    load.loadTierDepths.mockResolvedValueOnce([lowRow("100")]);
    const { container } = render(await TiersPage());
    const summary = container.querySelector("summary");
    expect(summary?.textContent).toMatch(/1\s*agent\b/);
    expect(summary?.textContent).not.toMatch(/1\s*agents/);
  });

  it("counts pools in the summary, so a number is a number of things to act on", async () => {
    auth.currentUser.mockResolvedValueOnce(superAdmin);
    load.loadTierDepths.mockResolvedValueOnce(
      ["100", "101", "102", "110", "111", "112"].map(lowRow),
    );
    render(await TiersPage());
    // One pool on a single agent, not six. Before this the same roster read as
    // "6 on a single agent today", which is half a tier reported as six problems.
    const strip = screen.getByText(/on a single agent today/i).parentElement;
    expect(strip?.textContent).toMatch(/1\s*on a single agent today/);
    expect(screen.getByText(/pools/i)).toBeTruthy();
  });
});

describe("TiersPage on an unreadable roster (#1629)", () => {
  const superAdmin = {
    id: "s1",
    role: "super_admin",
    org_id: "o1",
    email: "s@x.com",
    theme_preference: null,
    bookable: false,
    avatar_url: null,
  };

  it("renders its own unreadable state, NOT the empty-roster copy", async () => {
    auth.currentUser.mockResolvedValueOnce(superAdmin);
    // What loadTierDepths does now on an unreadable table. Before #1629 it
    // resolved [] here and this page said it had no routing pools, which on this
    // screen reads as every pool having lost its agents.
    load.loadTierDepths.mockRejectedValueOnce(
      new Error("read failed [staffing depth buckets]: connection reset"),
    );
    render(await TiersPage());

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/could not be read/i);
    // The empty-state sentence must NOT appear: an unreadable roster and a roster
    // with no tiers are different screens (L10).
    expect(screen.queryByText(/No routing pools yet/i)).toBeNull();
  });

  it("reports no count at all rather than a zero it never measured", async () => {
    auth.currentUser.mockResolvedValueOnce(superAdmin);
    load.loadTierDepths.mockRejectedValueOnce(new Error("read failed [staffing depth users]: boom"));
    const { container } = render(await TiersPage());

    // The summary strip is what turns an unmeasured roster into numbers, so it is
    // absent entirely. A "0 with no coverage" here would be a claim nothing made.
    expect(screen.queryByText(/with no coverage/i)).toBeNull();
    expect(screen.queryByText(/on a single agent today/i)).toBeNull();
    expect(screen.queryByText(/agent-slots out today/i)).toBeNull();
    expect(container.querySelector("table")).toBeNull();
  });

  it("proves the control: the same page still renders the table when the read succeeds", async () => {
    auth.currentUser.mockResolvedValueOnce(superAdmin);
    load.loadTierDepths.mockResolvedValueOnce([]);
    const { container } = render(await TiersPage());
    // An EMPTY read is a measurement, so the counts and the empty-state copy are
    // exactly what should show. This is the half the assertions above would
    // otherwise be satisfied by a page that renders nothing at all.
    expect(screen.getByText(/No routing pools yet/i)).toBeTruthy();
    expect(screen.getByText(/with no coverage/i)).toBeTruthy();
    expect(container.querySelector("table")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
