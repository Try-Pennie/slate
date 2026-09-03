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
    { href: "/admin/default-hours", label: "Default hours", gate: "admin" },
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
