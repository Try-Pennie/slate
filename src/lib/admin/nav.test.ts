import { describe, it, expect } from "vitest";
import {
  ADMIN_NAV,
  visibleAdminNav,
  activeAdminHref,
  adminNavHrefs,
  adminNavFor,
  type AdminGate,
} from "@/lib/admin/nav";
import { ROLES } from "@/lib/auth/roles";
import type { Role } from "@/lib/db/types";

// #1748: /admin was one flat scroll of about 15 sections with no way to jump
// between them, and a second overloaded hub at /admin/settings holding 12 more.
// The sidebar is the map. These tests pin the properties that decide whether it
// is a map or a decoration.

describe("the admin nav map", () => {
  it("gives every entry a group, a label, a route and a gate", () => {
    for (const group of ADMIN_NAV) {
      // #1790: a group may deliberately carry NO title (the overview), but a
      // title that exists has to say something.
      if (group.title !== null) expect(group.title).toBeTruthy();
      expect(group.items.length).toBeGreaterThan(0);
      for (const item of group.items) {
        expect(item.label).toBeTruthy();
        expect(item.href.startsWith("/admin")).toBe(true);
        expect(["manager", "admin", "super_admin"]).toContain(item.gate);
      }
    }
  });

  it("names each route once", () => {
    // A route in two groups highlights twice and reads as two different things.
    const hrefs = adminNavHrefs();
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("names each label once", () => {
    const labels = ADMIN_NAV.flatMap((g) => g.items.map((i) => i.label));
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("visibleAdminNav", () => {
  it("shows a super admin everything", () => {
    expect(visibleAdminNav("super_admin").flatMap((g) => g.items)).toHaveLength(
      adminNavHrefs().length,
    );
  });

  it("hides what a manager cannot use rather than listing it and refusing", () => {
    const managerHrefs = visibleAdminNav("manager").flatMap((g) =>
      g.items.map((i) => i.href),
    );
    const adminOnly = ADMIN_NAV.flatMap((g) => g.items).filter(
      (i) => i.gate !== "manager",
    );
    expect(adminOnly.length).toBeGreaterThan(0);
    for (const item of adminOnly) {
      expect(managerHrefs).not.toContain(item.href);
    }
  });

  it("keeps team access to a super admin, since only a super admin may grant it", () => {
    for (const role of ["manager", "team_lead", "admin"] as Role[]) {
      expect(
        visibleAdminNav(role).flatMap((g) => g.items.map((i) => i.gate)),
      ).not.toContain("super_admin");
    }
    expect(
      visibleAdminNav("super_admin").flatMap((g) => g.items.map((i) => i.gate)),
    ).toContain("super_admin");
  });

  it("drops a group that has nothing left in it", () => {
    // An empty heading is a promise of a section that is not there.
    for (const role of ROLES) {
      for (const group of visibleAdminNav(role)) {
        expect(group.items.length).toBeGreaterThan(0);
      }
    }
  });

  // #1790: a heading over one item reads as a container with more inside it, so
  // the sidebar promises a section that is not there. Counted AFTER the gate
  // filter, because a group can hold three entries and still render one for a
  // given role (L101): a manager saw three such headings, not just the overview,
  // so this is the class rather than the one instance (L30).
  it("never puts a heading over a single item, for any role", () => {
    for (const role of ROLES) {
      for (const group of visibleAdminNav(role)) {
        if (group.title !== null) {
          expect(
            group.items.length,
            `${role} sees heading "${group.title}" over ${group.items.length} item(s)`,
          ).toBeGreaterThanOrEqual(2);
        }
      }
    }
  });

  it("drops the heading and keeps the item, never the other way round", () => {
    // A manager may see only Roster out of the three Agents entries. The entry
    // has to survive; it is the heading that is wrong, not the link.
    const manager = visibleAdminNav("manager");
    const hrefs = manager.flatMap((g) => g.items.map((i) => i.href));
    expect(hrefs).toContain("/admin/agents");
    expect(hrefs).toContain("/admin/bookings");
    const holding = manager.find((g) => g.items.some((i) => i.href === "/admin/agents"));
    expect(holding?.title).toBeNull();
  });

  it("leaves the overview unheaded for everyone who can see it", () => {
    for (const role of ROLES) {
      const group = visibleAdminNav(role).find((g) =>
        g.items.some((i) => i.href === "/admin"),
      );
      if (group) expect(group.title).toBeNull();
    }
  });

  it("keeps a heading that still covers two or more items", () => {
    // The demotion must not eat every heading: an admin's Bookings group holds
    // four and has to keep saying so.
    const admin = visibleAdminNav("admin");
    const bookings = admin.find((g) => g.items.some((i) => i.href === "/admin/bookings"));
    expect(bookings?.title).toBe("Bookings");
    expect(admin.filter((g) => g.title !== null).length).toBeGreaterThan(3);
  });

  it("shows an agent nothing at all", () => {
    // An agent cannot reach /admin, so the sidebar has nothing to offer them.
    expect(visibleAdminNav("agent")).toEqual([]);
  });

  it("never grows the set as the role drops", () => {
    // The gates are ranked, so seeing MORE with less power is a broken gate, and
    // it is the direction that leaks rather than the one that annoys.
    const counts = (["manager", "team_lead", "admin", "super_admin"] as Role[]).map(
      (r) => visibleAdminNav(r).flatMap((g) => g.items).length,
    );
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]!).toBeGreaterThanOrEqual(counts[i - 1]!);
    }
  });
});

describe("activeAdminHref", () => {
  it("marks the exact page you are on", () => {
    expect(activeAdminHref("/admin/buckets")).toBe("/admin/buckets");
  });

  it("marks the section a record detail page belongs to", () => {
    // A row opens a detail page that is not itself in the nav; the section it
    // came from stays lit rather than the whole sidebar going dark.
    expect(activeAdminHref("/admin/agents/abc-123")).toBe("/admin/agents");
    expect(activeAdminHref("/admin/bookings/xyz")).toBe("/admin/bookings");
  });

  it("does not let the overview swallow every other page", () => {
    // "/admin" is a prefix of all of them, so a plain prefix match lights the
    // overview on every screen and the highlight stops meaning anything.
    expect(activeAdminHref("/admin")).toBe("/admin");
    expect(activeAdminHref("/admin/audit")).toBe("/admin/audit");
    expect(activeAdminHref("/admin/audit")).not.toBe("/admin");
  });

  it("prefers the longest match when one route sits under another", () => {
    const hrefs = adminNavHrefs();
    const nested = hrefs.filter((h) =>
      hrefs.some((other) => other !== h && h.startsWith(other + "/")),
    );
    for (const h of nested) expect(activeAdminHref(h)).toBe(h);
  });

  it("returns null for a path the nav does not cover", () => {
    // Null, not a guess: lighting a plausible neighbour is worse than lighting
    // nothing, because it tells you where you are and is wrong.
    expect(activeAdminHref("/me")).toBeNull();
    expect(activeAdminHref("/admin/nothing-here")).toBeNull();
  });
});

describe("the gates are the ranked roles, in order", () => {
  it("orders manager below admin below super admin", () => {
    const gates: AdminGate[] = ["manager", "admin", "super_admin"];
    const reach = gates.map(
      (g) =>
        ROLES.filter((r) =>
          visibleAdminNav(r).flatMap((x) => x.items).some((i) => i.gate === g),
        ).length,
    );
    // Fewer roles can see each successively stricter gate.
    expect(reach[0]!).toBeGreaterThan(reach[1]!);
    expect(reach[1]!).toBeGreaterThan(reach[2]!);
  });
});

describe("adminNavFor", () => {
  it("gives a super admin the whole map while scheduling is not live", () => {
    // The one role the OOO-only phase does not bounce.
    expect(adminNavFor("super_admin", false).length).toBeGreaterThan(0);
  });

  it("gives nobody a sidebar while the OOO-only phase is bouncing them", () => {
    // Every console link would land them straight back on /admin/ooo, so a
    // sidebar here is a column of controls that can only refuse.
    for (const role of ROLES) expect(adminNavFor(role, true)).toEqual([]);
  });

  it("is the plain visible map once the phase is over", () => {
    for (const role of ROLES) {
      expect(adminNavFor(role, false)).toEqual(visibleAdminNav(role));
    }
  });
});
