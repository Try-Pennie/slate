// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";

// #1757: the grouping, scope and order are pinned offline in
// `scripts/test-team-hours.ts`. What is pinned HERE is what only a render shows:
// that an agent with no hours never draws a week, that the per agent editor is one
// click from every name, and that a manager's own view does not repeat the page's
// subject as a team heading while an admin's names each team.
import { TeamHoursTable } from "./TeamHoursTable";
import { buildTeamHours, type TeamHoursGroup } from "@/lib/admin/team-hours";

const ORG = {
  default_timezone: "America/New_York",
  default_start_minute: 480,
  default_end_minute: 1020,
  default_weekdays: [1, 2, 3, 4, 5],
};

function groups(scope: "all" | "team"): TeamHoursGroup[] {
  return buildTeamHours({
    scope: scope === "all" ? { kind: "all" } : { kind: "team", managerId: "m1" },
    agents: [
      { id: "a1", name: "Ann Hours", email: "ann@x.com", manager_id: "m1", bookable: true },
      { id: "a2", name: "Bea Nohours", email: "bea@x.com", manager_id: "m1", bookable: false },
      { id: "a3", name: "Cal Other", email: "cal@x.com", manager_id: "m2", bookable: true },
    ],
    schedules: [
      {
        user_id: "a1",
        timezone: "America/Phoenix",
        hours_source: "calcom-import",
        hours_set_at: null,
        created_at: "2026-08-01T00:00:00Z",
        rules: [{ weekday: 2, start_minute: 600, end_minute: 1080 }],
      },
      {
        user_id: "a3",
        timezone: "America/Chicago",
        hours_source: "agent",
        hours_set_at: null,
        created_at: "2026-08-01T00:00:00Z",
        rules: [{ weekday: 1, start_minute: 540, end_minute: 1020 }],
      },
    ],
    managers: new Map([
      ["m1", "Mia Manager"],
      ["m2", "Max Manager"],
    ]),
    org: ORG,
  });
}

describe("TeamHoursTable", () => {
  it("renders an agent's own zone and week, and links their name to the hours editor", () => {
    render(<TeamHoursTable groups={groups("team")} showTeamHeadings={false} />);
    const link = screen.getByRole("link", { name: "Ann Hours" });
    expect(link.getAttribute("href")).toBe("/admin/agents/a1");
    const row = link.closest("tr")!;
    expect(within(row).getByText("Arizona (Phoenix)")).toBeTruthy();
    expect(within(row).getByText("10:00am")).toBeTruthy();
    expect(within(row).getByText("6:00pm")).toBeTruthy();
    expect(within(row).getByText("Copied from cal.com")).toBeTruthy();
    // Six days off, each said, never an empty cell.
    expect(within(row).getAllByText("Off")).toHaveLength(6);
  });

  it("says an agent with no hours has none, and draws no week for them", () => {
    render(<TeamHoursTable groups={groups("team")} showTeamHeadings={false} />);
    const row = screen.getByRole("link", { name: "Bea Nohours" }).closest("tr")!;
    expect(within(row).getByText(/No working hours/)).toBeTruthy();
    // The form's Monday to Friday fallback must not leak into a report of what is
    // stored: no times and no "Off" days on this row at all.
    expect(within(row).queryByText(/\d(am|pm)$/)).toBeNull();
    expect(within(row).queryByText("Off")).toBeNull();
    // And the positive half on the same fixture, so this is not a blank table (L159).
    expect(screen.getByText("10:00am")).toBeTruthy();
  });

  it("names each team for an admin, and not for a manager reading their own", () => {
    const { unmount } = render(<TeamHoursTable groups={groups("all")} showTeamHeadings />);
    expect(screen.getByRole("heading", { name: /Mia Manager/ })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Max Manager/ })).toBeTruthy();
    unmount();
    render(<TeamHoursTable groups={groups("team")} showTeamHeadings={false} />);
    expect(screen.queryByRole("heading", { name: /Manager/ })).toBeNull();
    expect(screen.queryByText("Cal Other")).toBeNull();
  });

  it("names the group with no manager of record", () => {
    const g = buildTeamHours({
      scope: { kind: "all" },
      agents: [{ id: "u", name: "Uma", email: "u@x.com", manager_id: null, bookable: true }],
      schedules: [],
      managers: new Map(),
      org: ORG,
    });
    render(<TeamHoursTable groups={g} showTeamHeadings />);
    expect(screen.getByRole("heading", { name: /No manager of record/ })).toBeTruthy();
  });
});
