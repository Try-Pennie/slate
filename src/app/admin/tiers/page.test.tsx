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
      },
    ]);
    render(await TiersPage());
    // The inline cell shows the roster count with the available-today annotation.
    const agentsCell = screen.getByText(
      (_, el) => el?.tagName === "TD" && /^4\s*\(1 today\)$/.test((el.textContent ?? "").trim()),
    );
    expect(agentsCell).toBeTruthy();
    // Detail spells out roster vs available today and the time-off count.
    expect(screen.getByText(/4 on the roster/i)).toBeTruthy();
    expect(screen.getByText(/3 on approved time off/i)).toBeTruthy();
    // The status pill reflects the EFFECTIVE risk, not the roster-OK flag.
    expect(screen.getByText(/single point of failure/i)).toBeTruthy();
  });
});
