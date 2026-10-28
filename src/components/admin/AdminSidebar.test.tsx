// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AdminSidebar } from "@/components/admin/AdminSidebar";
import { visibleAdminNav, type AdminNavGroup } from "@/lib/admin/nav";

// The sidebar is the admin area's map (#1748). These assert what it DRAWS, which
// the pure nav tests cannot see: `visibleAdminNav` can correctly report a group
// as unheaded while the component renders a heading anyway (L3).

// #2506: the path is a fixture rather than a constant now, because the small
// width control names the section the path is in, and closing on arrival is a
// behaviour only a path that MOVES can show.
const route = vi.hoisted(() => ({ pathname: "/admin" }));
vi.mock("next/navigation", () => ({ usePathname: () => route.pathname }));

beforeEach(() => {
  route.pathname = "/admin";
});

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

  // The end to end version of the rule, over the REAL map rather than fixtures
  // (#2043): every group a manager is shown, apart from the one at the top,
  // draws a heading. The sidebar puts a 24px gap above each group, and the
  // heading is the only thing that says what the gap is for, so a group without
  // one in the middle of the list is an empty space that reads as a mistake.
  it("draws a heading over every group but the first, for a manager's and an admin's real map", () => {
    // #4299: Reminder emails gave a manager's Bookings group a second entry, so the
    // single entry groups this exists for are counted across both roles' maps.
    let collapsedSeen = 0;
    for (const role of ["manager", "admin"] as const) {
      const groups = visibleAdminNav(role);
      const { unmount } = render(<AdminSidebar groups={groups} />);
      const drawn = screen.getAllByRole("heading").map((h) => h.textContent ?? "");

      groups.forEach((group, i) => {
        if (i === 0) return;
        expect(group.title, `group ${i} (${group.items[0]!.href}) has no heading`).not.toBeNull();
        expect(drawn, `heading for ${group.items[0]!.href}`).toContain(group.title);
      });

      // Groups that hold ONE entry are the point of this: they draw a heading
      // like any other.
      const collapsed = groups.filter((g, i) => i > 0 && g.items.length === 1);
      collapsedSeen += collapsed.length;
      for (const g of collapsed) expect(drawn).toContain(g.title);

      // An EMPTY heading is the shape the original defect took: the component drew
      // an <h2> holding a null title, which a by-name check cannot see.
      for (const text of drawn) expect(text.trim()).toBeTruthy();
      unmount();
    }
    // A positive control, since maps that happened to collapse nothing would
    // prove nothing here (L98).
    expect(collapsedSeen, "a real map really does hold single entry groups").toBeGreaterThan(0);
  });
});

// #1841: a group with no heading needs something else marking it as deliberate.
//
// Dan, on the top of the sidebar: Health floated alone above the first heading
// and read as stranded, an orphan sitting above the structured part of the list
// rather than as the first thing in the map.
//
// The fix is NOT to give it a heading. #1790's rule stands where it was written:
// at the top of the list a heading over a single item promises a section that is
// not there. So the headingless group gets a rule beneath it instead, which
// separates it from the grouped sections without claiming to be one.
//
// It is asserted for ANY headingless group rather than only the first, because
// that is the property the component's condition actually reads. Since #2043 the
// live map only ever puts one at the top, which `nav.test.ts` enforces; these
// stay as fixtures so the component's own contract is pinned independently of
// what the current list happens to contain.
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

// #2506: below the `lg` breakpoint this was the sidebar with its `lg:` classes
// switched off, laid out as a horizontal row of groups. It read as three
// fragments on two baselines, and every group past Routing sat off the right
// edge with nothing saying the row continued (L76), so most of the admin area
// was reachable only by guessing that it scrolled.
//
// The treatment is ONE control that names the section the reader is in and opens
// the whole grouped list beneath it. These pin the parts no browser pass can be
// asked about in CI: what the control is called, what it opens, and when it
// shuts. The look itself is checked in a browser at three widths in both themes.
describe("the small width control (#2506)", () => {
  const trigger = () => screen.getByRole("button");
  const panel = () => {
    const id = trigger().getAttribute("aria-controls");
    expect(id, "the control names the list it opens").toBeTruthy();
    const el = document.getElementById(id!);
    expect(el, "the list the control names really exists").toBeTruthy();
    return el!;
  };

  it("names the section the reader is in", () => {
    route.pathname = "/admin/agents/abc";
    render(<AdminSidebar groups={visibleAdminNav("admin")} />);
    // The ENTRY, not the route: a record detail page is still Roster.
    expect(trigger().textContent).toContain("Roster");
  });

  it("says so plainly when no section claims the path", () => {
    route.pathname = "/admin/nowhere";
    render(<AdminSidebar groups={visibleAdminNav("admin")} />);
    // Never a nearest guess. A control confidently naming the wrong section
    // tells you where you are and is lying, which is worse than saying nothing.
    expect(trigger().textContent).toContain("Admin sections");
  });

  it("starts closed and opens on a press", () => {
    render(<AdminSidebar groups={visibleAdminNav("admin")} />);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(panel().classList.contains("hidden")).toBe(true);
    fireEvent.click(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(panel().classList.contains("hidden")).toBe(false);
  });

  it("still shows the whole map from lg up, however the control was left", () => {
    // The desktop sidebar is not a disclosure. Whatever the control's state
    // happens to be, the list is shown from `lg` up, or widening a window with
    // it closed would leave the sidebar empty.
    render(<AdminSidebar groups={visibleAdminNav("admin")} />);
    expect(panel().classList.contains("lg:block")).toBe(true);
    fireEvent.click(trigger());
    expect(panel().classList.contains("lg:block")).toBe(true);
  });

  it("closes on Escape and hands focus back to the control", () => {
    render(<AdminSidebar groups={visibleAdminNav("admin")} />);
    fireEvent.click(trigger());
    const first = screen.getAllByRole("link")[0]!;
    first.focus();
    fireEvent.keyDown(first, { key: "Escape" });
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement, "the keyboard is not stranded").toBe(trigger());
  });

  it("closes once the page has actually changed, not on the press", () => {
    // Every entry carries an in flight marker, so closing on the click would
    // unmount the link that was pressed and take its feedback away mid
    // navigation. The arrival is what shuts it.
    const { rerender } = render(<AdminSidebar groups={visibleAdminNav("admin")} />);
    fireEvent.click(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    route.pathname = "/admin/buckets";
    rerender(<AdminSidebar groups={visibleAdminNav("admin")} />);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(trigger().textContent, "and it names where you now are").toContain("Buckets");
  });

  it("marks the entry the reader is on for assistive tech too", () => {
    route.pathname = "/admin/buckets";
    render(<AdminSidebar groups={visibleAdminNav("admin")} />);
    const current = screen
      .getAllByRole("link")
      .filter((l) => l.getAttribute("aria-current") === "page");
    expect(current.map((l) => l.textContent)).toEqual(["Buckets"]);
  });

  it("declares a 44px target on the control", () => {
    // jsdom has no layout, so this pins the DECLARATION; the measured size is
    // checked in a browser.
    render(<AdminSidebar groups={visibleAdminNav("admin")} />);
    expect(trigger().classList.contains("min-h-11")).toBe(true);
  });
});
