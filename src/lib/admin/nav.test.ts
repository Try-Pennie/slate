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

  // #2043: the #1790 demotion is NARROWED to the position it was written for.
  //
  // Dropping a heading also drops the only thing explaining the 24px gap above
  // the group, so in the MIDDLE of the list it trades a heading over one item
  // for an empty space that reads as a layout fault. #1841's compensating rule
  // sits BELOW the group, on the wrong side of the gap it is answering.
  //
  // Dan's call, 2026-09-07: give it the heading back. So a heading is now
  // whatever the static list declares, and a group that collapses to one item
  // for a given role keeps saying what it is.
  it("keeps Monitoring's heading, which is one item for everyone", () => {
    const admin = visibleAdminNav("admin");
    const monitoring = admin.find((g) => g.items.some((i) => i.href === "/admin/alerts"));
    expect(monitoring?.items.length, "the group really is a single item").toBe(1);
    expect(monitoring?.title).toBe("Monitoring");
  });

  it("keeps the heading of a group that COLLAPSES to one item for a role", () => {
    // The class, not the instance: a manager sees one of the three Agents
    // entries, and that group has the same unexplained gap Monitoring had.
    const manager = visibleAdminNav("manager");
    const agents = manager.find((g) => g.items.some((i) => i.href === "/admin/agents"));
    expect(agents?.items.length, "collapsed for a manager").toBe(1);
    expect(agents?.title).toBe("Agents");
    // The gate takes the entries, never the group's name for what they are: the
    // half of the old rule that survives its reversal.
    expect(agents?.items[0]!.href).toBe("/admin/agents");
    expect(manager.flatMap((g) => g.items.map((i) => i.href))).toContain("/admin/bookings");
  });

  it("only the FIRST group may declare no heading", () => {
    // What replaces the demotion. A headingless group anywhere else is a gap
    // with nothing explaining it, and the static list is the only place one can
    // now come from, so this is where it is caught (L96).
    ADMIN_NAV.forEach((group, i) => {
      if (i > 0) {
        expect(group.title, `group ${i} (${group.items[0]?.href}) declares no heading`)
          .not.toBeNull();
      }
    });
    // A positive control: the first group really does declare none, so an
    // all-headed list cannot be what makes this pass (L98).
    expect(ADMIN_NAV[0]!.title).toBeNull();
  });

  it("never manufactures a heading the static list did not declare", () => {
    for (const role of ROLES) {
      for (const group of visibleAdminNav(role)) {
        const declared = ADMIN_NAV.find((g) => g.items.some((i) => i.href === group.items[0]!.href));
        expect(group.title, `${role} sees ${group.items[0]!.href}`).toBe(declared!.title);
      }
    }
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
