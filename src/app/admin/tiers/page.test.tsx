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

  it("shows the deny notice to a signed-in agent instead of the report", async () => {
    auth.currentUser.mockResolvedValueOnce({ id: "a1", role: "agent", org_id: "o1" });
    render(await TiersPage());
    expect(screen.getByText(/manager or admin account to view staffing depth/i)).toBeTruthy();
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
