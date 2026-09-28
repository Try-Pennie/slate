// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// #1757: the page's own decisions. The loader's reads and the builder's order are
// tested beside them; what is pinned here is that the page ASKS for the right
// scope, and that each way of learning nothing reads as itself (L10, L11): an
// unreadable roster, unreadable hours, and a manager nobody reports to are three
// different sentences, and none of them draws a table of empty weeks.
const auth = vi.hoisted(() => ({ currentUser: vi.fn() }));
const env = vi.hoisted(() => ({ consoleHiddenFor: vi.fn(() => false) }));
const load = vi.hoisted(() => ({ loadTeamHours: vi.fn() }));
const redirect = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
);

vi.mock("@/lib/auth", () => auth);
vi.mock("@/lib/env", () => env);
vi.mock("@/lib/admin/team-hours-load", () => load);
vi.mock("next/navigation", () => ({
  redirect,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/admin/team-hours",
}));

import TeamHoursPage from "./page";

const user = (role: string) => ({
  id: "me",
  role,
  org_id: "o1",
  email: "me@x.com",
  name: "Mia Manager",
});

const ROW = {
  managerId: "me",
  managerName: "Mia Manager",
  rows: [
    {
      id: "a1",
      name: "Ann",
      email: "ann@x.com",
      bookable: true,
      hours: {
        kind: "set" as const,
        zone: "America/Chicago",
        zoneLabel: "Central time (Chicago)",
        days: [[{ start: "9:00am", end: "5:00pm" }], [], [], [], [], [], []],
        setBy: "agent" as const,
      },
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  env.consoleHiddenFor.mockReturnValue(false);
});

describe("TeamHoursPage", () => {
  it("asks for a manager's own team, and an admin's for everybody", async () => {
    load.loadTeamHours.mockResolvedValue({ kind: "ok", groups: [ROW] });
    auth.currentUser.mockResolvedValue(user("manager"));
    render(await TeamHoursPage());
    expect(load.loadTeamHours.mock.calls[0]![1]).toEqual({ kind: "team", managerId: "me" });
    expect(screen.getByRole("link", { name: "Ann" })).toBeTruthy();

    auth.currentUser.mockResolvedValue(user("admin"));
    render(await TeamHoursPage());
    expect(load.loadTeamHours.mock.calls[1]![1]).toEqual({ kind: "all" });
  });

  it("refuses an agent without reading anything", async () => {
    auth.currentUser.mockResolvedValue(user("agent"));
    render(await TeamHoursPage());
    expect(load.loadTeamHours).not.toHaveBeenCalled();
    expect(screen.getByText(/manager or admin account/i)).toBeTruthy();
  });

  it("says the hours could not be read, and never draws a week of nothing", async () => {
    auth.currentUser.mockResolvedValue(user("manager"));
    load.loadTeamHours.mockResolvedValue({ kind: "unreadable", what: "hours" });
    render(await TeamHoursPage());
    expect(screen.getByRole("alert").textContent).toMatch(/working hours could not be read/i);
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText(/No working hours/)).toBeNull();
  });

  it("says the roster could not be read in its own words", async () => {
    auth.currentUser.mockResolvedValue(user("manager"));
    load.loadTeamHours.mockResolvedValue({ kind: "unreadable", what: "roster" });
    render(await TeamHoursPage());
    expect(screen.getByRole("alert").textContent).toMatch(/team could not be read/i);
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("tells a manager nobody reports to them, rather than showing an empty table", async () => {
    auth.currentUser.mockResolvedValue(user("manager"));
    load.loadTeamHours.mockResolvedValue({ kind: "ok", groups: [] });
    render(await TeamHoursPage());
    expect(screen.getByText(/nobody has you as their manager/i)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
