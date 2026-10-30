import { atLeast, canEditOrgSettings, canManageAgents } from "@/lib/auth/roles";
import type { Role } from "@/lib/db/types";

/**
 * The admin area's map (#1748).
 *
 * `/admin` was one flat scroll of about 15 sections with no way to jump between
 * them, and a second overloaded hub at `/admin/settings` held 12 more. Four
 * screens (the erasure worklist, the stuck-delivery drain, the booking API
 * outcomes and the reason options) were reachable ONLY from that second hub,
 * which was itself reachable only through a card labelled "Alert settings",
 * describing none of them.
 *
 * So this is the one place the admin area's shape is written: which sections
 * exist, which group each belongs to, and who may see it. The sidebar renders it
 * and `scripts/test-admin-nav-reachability.ts` holds it to the routes it names, so a
 * link cannot claim a different audience than the page it opens, and no admin
 * screen can exist with nothing pointing at it.
 *
 * ONE list, not two. A hand-maintained sidebar beside hand-written page gates is
 * exactly the shape where a link stays after its page is gated tighter, and the
 * person clicking it gets a refusal rather than never seeing the link (L96).
 */

/**
 * Who may see an entry, named by the LOWEST role that may. These are the three
 * gates the admin pages actually use; a fourth would need a predicate here and a
 * matching one on the route.
 */
export type AdminGate = "manager" | "admin" | "super_admin";

export interface AdminNavItem {
  /** The route. Also the identity of the entry: no two entries share one. */
  href: string;
  label: string;
  gate: AdminGate;
}

export interface AdminNavGroup {
  /**
   * The heading, or null for a group that renders with none (#1790, narrowed by
   * #2043).
   *
   * Only the FIRST group may declare null, and exactly one does: the overview,
   * which is a single link that belongs at the top rather than folded into a
   * section it does not describe. Anywhere else a missing heading leaves the gap
   * above the group unexplained, which reads as a layout fault rather than as a
   * section break, so a group that collapses to one item for a given role keeps
   * its heading instead.
   */
  title: string | null;
  items: AdminNavItem[];
}

/** Whether `role` may see an entry behind `gate`. */
export function passesGate(role: Role, gate: AdminGate): boolean {
  if (gate === "manager") return canManageAgents(role);
  if (gate === "admin") return canEditOrgSettings(role);
  return atLeast(role, "super_admin");
}

export const ADMIN_NAV: AdminNavGroup[] = [
  {
    // No heading: it is one link, and the landing page belongs at the top rather
    // than folded into a section it does not describe (#1790).
    title: null,
    // #1841: "Overview", not "Health". A one word topic at the top of a list of
    // topics reads as one that ought to have siblings; naming it for what it IS,
    // the page you land on, stops it asking to be grouped. The PAGE keeps its own
    // title, since it really is the health dashboard, and a terse nav label over
    // a fuller page title is already the pattern on six other entries here.
    //
    // Admin only since 2026-10-02 (Dan): the page is the platform's health, which
    // is an admin's job. A manager or team lead reaching /admin is sent to the
    // roster, which is the first entry of their map, and the header's Admin tab
    // takes them there directly (`consoleHomeFor` below).
    items: [{ href: "/admin", label: "Overview", gate: "admin" }],
  },
  {
    title: "Agents",
    items: [
      { href: "/admin/agents", label: "Roster", gate: "manager" },
      { href: "/admin/team-access", label: "Team access", gate: "super_admin" },
      // #1892: "Default hours" is gone from here. The new agent seeding template
      // is a section of the Hours page under Availability now, with every other
      // hours decision. `/admin/default-hours` redirects there rather than 404ing,
      // so an old link still lands somewhere useful; it has no navigation entry
      // because nothing should send anybody to a redirect.
    ],
  },
  {
    title: "Routing",
    items: [
      { href: "/admin/buckets", label: "Buckets", gate: "admin" },
      { href: "/admin/tiers", label: "Staffing depth", gate: "manager" },
      { href: "/admin/routing", label: "Recent routing", gate: "manager" },
    ],
  },
  {
    title: "Availability",
    items: [
      // #1892: "Hours", because this page holds the org's operating window, the
      // holiday closures, the booking horizon AND the new agent template.
      { href: "/admin/business-hours", label: "Hours", gate: "admin" },
      { href: "/admin/availability", label: "Agent availability", gate: "manager" },
      // #1757: every agent's week grouped by manager, so a team can be checked in
      // one pass. A manager sees their own reports; an admin sees every team.
      { href: "/admin/team-hours", label: "Team hours", gate: "manager" },
      {
        href: "/admin/bucket-availability",
        label: "Bucket availability",
        gate: "manager",
      },
      // #3936: last under Availability, beside Team hours (D1 in docs/design/team-capacity.html).
      { href: "/admin/team-capacity", label: "Team capacity", gate: "manager" },
    ],
  },
  {
    title: "Bookings",
    items: [
      { href: "/admin/bookings", label: "Look up a booking", gate: "manager" },
      // #4264: the switch that lets coordinators put a call nobody is free for on Marcia, and
      // the coordinators themselves. Super admin only (D2 in docs/design/coordinator-admin.html),
      // after Look up a booking, which is opened more often (D1).
      { href: "/admin/coordinator-booking", label: "Coordinator booking", gate: "super_admin" },
      // #4392: program leads' last 14 days and the placeholder day limit. Admins only (Dan,
      // 2026-10-29), so the entry is gated "admin" like the page, which answers not found below.
      { href: "/admin/program-leads", label: "Program leads", gate: "admin" },
      { href: "/admin/booker-copy", label: "Booker copy", gate: "admin" },
      // #4299: the emails a lead gets before the call. Managers read them; admins edit.
      { href: "/admin/reminder-emails", label: "Reminder emails", gate: "manager" },
      { href: "/admin/booking-reasons", label: "Booking reasons", gate: "admin" },
      { href: "/admin/booking-outcomes", label: "API outcomes", gate: "admin" },
    ],
  },
  {
    title: "Integrations",
    items: [
      { href: "/admin/event-types", label: "Event types", gate: "admin" },
      { href: "/admin/webhooks", label: "Webhooks", gate: "admin" },
      // #3137: who frames the booker, and the lock that limits it to the allow list.
      { href: "/admin/embedding", label: "Embedding", gate: "admin" },
    ],
  },
  {
    title: "Monitoring",
    items: [
      // #1960: "Stuck deliveries" went with its route. It was empty by
      // construction (every row has already fired an alert) and had no controls,
      // so it is a panel on the Health page now, which is where somebody lands
      // after being paged.
      { href: "/admin/alerts", label: "Alerts and floors", gate: "admin" },
    ],
  },
  {
    title: "Compliance",
    items: [
      { href: "/admin/audit", label: "Audit log", gate: "admin" },
      { href: "/admin/erasure", label: "Data erasures", gate: "admin" },
    ],
  },
];

/**
 * Where the console starts for `role`: the Overview for an admin or above, the
 * roster for a manager or team lead (Dan, 2026-10-02).
 *
 * The header's Admin tab links here so a manager never bounces through the
 * `/admin` redirect, and that redirect asks the same predicate, so the two
 * cannot disagree about who the Overview is for.
 */
export function consoleHomeFor(role: Role): string {
  return canEditOrgSettings(role) ? "/admin" : "/admin/agents";
}

/** Every route the nav names, in nav order. */
export function adminNavHrefs(): string[] {
  return ADMIN_NAV.flatMap((g) => g.items.map((i) => i.href));
}

/**
 * The map as `role` sees it. An entry they cannot use is not listed, rather than
 * listed and refused: a control that can only ever produce an error is worse than
 * no control (L109). A group left with nothing in it is dropped too, since an
 * empty heading promises a section that is not there.
 */
export function visibleAdminNav(role: Role): AdminNavGroup[] {
  return ADMIN_NAV.map((g) => ({
    // The heading is whatever the static list DECLARES. It used to be demoted
    // here whenever the gate left a group with fewer than two items (#1790), and
    // that is narrowed to the one position it was written for (#2043).
    //
    // A heading is not only a label, it is the only thing explaining the 24px
    // gap the sidebar puts ABOVE its group. Dropping it in the middle of the
    // list traded a heading over one item for an empty space that reads as a
    // layout fault, and #1841's compensating rule is drawn BELOW the group, on
    // the wrong side of the gap it was answering. Monitoring is the instance Dan
    // reported, being a single item for everybody since #1960, but a manager saw
    // the same thing over Agents and Bookings.
    //
    // Dan's call, 2026-09-07: give it the heading back. At the TOP of the list
    // the original reasoning still holds, because there is no gap above the
    // first group to explain, and the overview declares `title: null` in the
    // list itself. Nothing computes a null any more, so a headingless group can
    // only come from the static list, and `nav.test.ts` holds that to the first
    // position, which is what replaces this rule rather than leaving the class
    // to be caught by review (L96).
    title: g.title,
    items: g.items.filter((i) => passesGate(role, i.gate)),
  })).filter((g) => g.items.length > 0);
}

/**
 * The map as it should actually be RENDERED for someone.
 *
 * The extra condition is the OOO-only launch phase: while agent scheduling is not
 * live, everyone below super admin is bounced to `/admin/ooo` on arrival at any
 * console page. Listing the console in the sidebar for them would be a column of
 * controls that can only ever bounce them back, which is the thing #1748 exists
 * to stop (L109). They have exactly one page, so they get no sidebar.
 *
 * Kept here rather than in the layout so the rule has one home and can be tested
 * without rendering anything.
 */
export function adminNavFor(role: Role, oooOnly: boolean): AdminNavGroup[] {
  return oooOnly ? [] : visibleAdminNav(role);
}

/**
 * Which entry the current path belongs to, or null.
 *
 * Longest match wins, so a record detail page (`/admin/agents/abc`) keeps its
 * section lit rather than leaving the whole sidebar dark. `/admin` is matched
 * EXACTLY, because it is a prefix of every other route and a plain prefix match
 * would light the overview on every screen, which makes the highlight mean
 * nothing.
 *
 * Null rather than a nearest guess: a highlight that is confidently wrong tells
 * you where you are and is lying, which is worse than telling you nothing.
 */
export function activeAdminHref(pathname: string): string | null {
  let best: string | null = null;
  for (const href of adminNavHrefs()) {
    const hit =
      href === "/admin"
        ? pathname === "/admin"
        : pathname === href || pathname.startsWith(href + "/");
    if (hit && (best === null || href.length > best.length)) best = href;
  }
  return best;
}

/**
 * The ENTRY the current path belongs to, within the groups actually shown (#2506).
 *
 * `activeAdminHref` answers with a route, which is all a highlight needs: the
 * link is already on screen carrying its own label. The small width control has
 * no list in front of it, so it has to say the section's NAME.
 *
 * It searches the groups it is HANDED rather than the whole map, because those
 * are already filtered for this person. A path they can somehow stand on but
 * whose entry their map does not list comes back null, so the control never
 * names a section that is not in the list it opens.
 */
export function activeAdminItem(
  groups: AdminNavGroup[],
  pathname: string,
): AdminNavItem | null {
  const href = activeAdminHref(pathname);
  if (href === null) return null;
  for (const group of groups) {
    for (const item of group.items) if (item.href === href) return item;
  }
  return null;
}
