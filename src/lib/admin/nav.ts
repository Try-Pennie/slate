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
 * and `scripts/test-admin-nav-gates.ts` holds it to the routes it names, so a
 * link cannot claim a different audience than the page it opens.
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
  title: string;
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
    title: "Overview",
    items: [{ href: "/admin", label: "Health", gate: "manager" }],
  },
  {
    title: "Agents",
    items: [
      { href: "/admin/agents", label: "Roster", gate: "manager" },
      { href: "/admin/team-access", label: "Team access", gate: "super_admin" },
      { href: "/admin/default-hours", label: "Default hours", gate: "admin" },
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
      { href: "/admin/business-hours", label: "Business hours", gate: "admin" },
      { href: "/admin/availability", label: "Agent availability", gate: "manager" },
      {
        href: "/admin/bucket-availability",
        label: "Bucket availability",
        gate: "manager",
      },
    ],
  },
  {
    title: "Bookings",
    items: [
      { href: "/admin/bookings", label: "Look up a booking", gate: "manager" },
      { href: "/admin/booker-copy", label: "Booker copy", gate: "admin" },
      { href: "/admin/booking-reasons", label: "Booking reasons", gate: "admin" },
      { href: "/admin/booking-outcomes", label: "API outcomes", gate: "admin" },
    ],
  },
  {
    title: "Integrations",
    items: [
      { href: "/admin/event-types", label: "Event types", gate: "admin" },
      { href: "/admin/webhooks", label: "Webhooks", gate: "admin" },
    ],
  },
  {
    title: "Monitoring",
    items: [
      { href: "/admin/alerts", label: "Alerts and floors", gate: "admin" },
      { href: "/admin/drain", label: "Stuck deliveries", gate: "admin" },
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
