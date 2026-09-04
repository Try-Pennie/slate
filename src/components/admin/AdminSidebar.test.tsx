// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { AdminSidebar } from "@/components/admin/AdminSidebar";
import { visibleAdminNav, type AdminNavGroup } from "@/lib/admin/nav";

// The sidebar is the admin area's map (#1748). These assert what it DRAWS, which
// the pure nav tests cannot see: `visibleAdminNav` can correctly report a group
// as unheaded while the component renders a heading anyway (L3).

vi.mock("next/navigation", () => ({ usePathname: () => "/admin" }));

const unheaded: AdminNavGroup = {
  title: null,
  items: [{ href: "/admin", label: "Health", gate: "manager" }],
};
const headed: AdminNavGroup = {
  title: "Agents",
  items: [
    { href: "/admin/agents", label: "Roster", gate: "manager" },
    // #1892: a real entry. This is sample data for the component rather than an
    // assertion about the live nav, but naming a route that has no navigation
    // entry any more reads as one.
    { href: "/admin/team-access", label: "Team access", gate: "super_admin" },
  ],
};

describe("AdminSidebar", () => {
  it("renders nothing at all when there are no groups", () => {
    const { container } = render(<AdminSidebar groups={[]} />);
    expect(container.firstChild).toBeNull();
  });

  // #1790: the defect. A heading over one item reads as a container with more
  // inside it, so a group carrying no title must draw no heading.
  it("draws no heading for an unheaded group, but still draws its link", () => {
    render(<AdminSidebar groups={[unheaded]} />);
    expect(screen.getByRole("link", { name: /health/i })).toBeTruthy();
    expect(screen.queryByRole("heading")).toBeNull();
  });

  it("still draws the heading for a group that has one", () => {
    render(<AdminSidebar groups={[headed]} />);
    expect(screen.getByRole("heading", { name: "Agents" })).toBeTruthy();
  });

  it("draws both kinds side by side without losing either", () => {
    render(<AdminSidebar groups={[unheaded, headed]} />);
    expect(screen.getAllByRole("heading").map((h) => h.textContent)).toEqual(["Agents"]);
    expect(screen.getAllByRole("link")).toHaveLength(3);
  });

  // The end to end version of the rule, over the REAL map rather than fixtures:
  // whatever a manager is shown, no heading it draws may cover a single link.
  it("draws no heading over a single link for a manager's real map", () => {
    const groups = visibleAdminNav("manager");
    render(<AdminSidebar groups={groups} />);
    const drawn = screen.getAllByRole("heading").map((h) => h.textContent ?? "");
    for (const group of groups) {
      if (group.title !== null && drawn.includes(group.title)) {
        expect(group.items.length, `heading "${group.title}"`).toBeGreaterThanOrEqual(2);
      }
    }
    // An EMPTY heading is the shape the defect took: the component drew an <h2>
    // holding a null title, which the by-name check above cannot see, so that
    // loop passed while the sidebar was still wrong.
    for (const text of drawn) expect(text.trim()).toBeTruthy();
    // A positive control: the manager map really does draw some headings, so an
    // empty heading list cannot be what makes this pass (L98).
    expect(drawn.length).toBeGreaterThan(0);
  });
});

// #1841: a group with no heading needs something else marking it as deliberate.
//
// Dan, on the top of the sidebar: Health floated alone above the first heading
// and read as stranded, an orphan sitting above the structured part of the list
// rather than as the first thing in the map.
//
// The fix is NOT to give it a heading. #1790's rule stands: a heading over a
// single item promises a section that is not there, and `visibleAdminNav`
// applies the same rule dynamically to any group that collapses to one item for
// the person looking. So the headingless group gets a rule beneath it instead,
// which separates it from the grouped sections without claiming to be one.
//
// It is asserted for ANY headingless group, not just the first, because which
// groups collapse differs per role and the top item is not the only one that can
// end up without a heading.
describe("a headingless group is marked as its own zone (#1841)", () => {
  const groupEls = (c: HTMLElement) =>
    Array.from(c.querySelectorAll("nav > ul > li")) as HTMLElement[];

  it("draws a rule beneath a headingless group that has sections after it", () => {
    const { container } = render(<AdminSidebar groups={[unheaded, headed]} />);
    const [first, second] = groupEls(container);
    expect(first!.className, "the headingless group is separated from what follows").toMatch(
      /border-b/,
    );
    expect(second!.className, "a group with a heading needs no rule; its heading is the mark")
      .not.toMatch(/border-b/);
  });

  it("draws no rule when the headingless group is the last thing in the list", () => {
    // A trailing rule under the final group is a line with nothing after it,
    // which marks a boundary that does not exist.
    const { container } = render(<AdminSidebar groups={[headed, unheaded]} />);
    const [, last] = groupEls(container);
    expect(last!.className).not.toMatch(/border-b/);
  });

  it("holds for a headingless group anywhere in the list, not only the first", () => {
    // Which groups collapse to a single item is different per role, so the top
    // item is not the only one that can lose its heading.
    const middle: AdminNavGroup = {
      title: null,
      items: [{ href: "/admin/audit", label: "Audit log", gate: "admin" }],
    };
    const { container } = render(<AdminSidebar groups={[headed, middle, headed]} />);
    const [, mid] = groupEls(container);
    expect(mid!.className).toMatch(/border-b/);
  });

  it("still draws no heading for it, so #1790's rule is intact", () => {
    render(<AdminSidebar groups={[unheaded, headed]} />);
    expect(screen.getAllByRole("heading").map((h) => h.textContent)).toEqual(["Agents"]);
  });
});
