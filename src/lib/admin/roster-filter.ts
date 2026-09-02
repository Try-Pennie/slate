import { isActive } from "@/lib/active-user";
import { teamsOf } from "@/lib/admin/agent-display";
import type { User } from "@/lib/db/types";

/**
 * The agent roster's filter, sort and paging, as pure functions (#1752).
 *
 * The roster is filtered in the BROWSER now. The whole list is already in the
 * page, the match is a lowercase `includes` over about 136 strings, and it used
 * to cost a navigation: a `router.replace` re-rendered the whole force-dynamic
 * admin page, which re-ran every read on it before a single row could change.
 *
 * That split one predicate across two runtimes, which is the shape where two
 * copies quietly stop agreeing and each reads as correct on its own. So the
 * predicate lives here, once, and BOTH callers use it: the client component on
 * every keystroke, and the server render that is also the no-JavaScript path.
 * Sharing the shape of the filters while copying the logic that applies them is
 * not sharing (L370), which is why the URL round trip is here too.
 */

/** The columns the filter and the sort actually read. */
export type RosterRow = Pick<
  User,
  | "id"
  | "name"
  | "email"
  | "role"
  | "bookable"
  | "manager_id"
  | "deactivated_at"
  | "attributes"
  | "avatar_url"
>;

export interface RosterFilters {
  /**
   * The search text. Normalised on the way out of a URL, and normalised again by
   * `filterRoster`: a caller that builds filters by hand and passes "Ada" would
   * otherwise match nothing at all, with no error anywhere, which is a wrong
   * answer that reads exactly like a correct empty one.
   */
  q: string;
  role: string;
  team: string;
  manager: string;
  /** "" any · "yes" · "no" */
  bookable: string;
}

/** Rows per rendered page, so the DOM stays bounded as the roster grows (#94). */
export const ROSTER_PAGE_SIZE = 50;

export const EMPTY_ROSTER_FILTERS: RosterFilters = {
  q: "",
  role: "",
  team: "",
  manager: "",
  bookable: "",
};

export function hasAnyRosterFilter(f: RosterFilters): boolean {
  return Boolean(f.q || f.role || f.team || f.manager || f.bookable);
}

/**
 * Everyone still on the roster who matches every filter that is set.
 *
 * Offboarded people are excluded first and unconditionally: they are not on the
 * roster at all, so no filter may bring one back.
 */
export function filterRoster<T extends RosterRow>(rows: T[], f: RosterFilters): T[] {
  const needle = f.q.trim().toLowerCase();
  return rows.filter((u) => {
    if (!isActive(u)) return false;
    if (f.role && u.role !== f.role) return false;
    if (f.bookable === "yes" && !u.bookable) return false;
    if (f.bookable === "no" && u.bookable) return false;
    if (f.team && !teamsOf(u as unknown as User).includes(f.team)) return false;
    if (f.manager && u.manager_id !== f.manager) return false;
    if (needle) {
      const hay = `${u.name ?? ""} ${u.email}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}

/**
 * Sort key: surname (last whitespace separated token of the display name),
 * falling back to the email when there is no name.
 */
function lastNameKey(u: RosterRow): string {
  const name = (u.name ?? "").trim();
  if (!name) return (u.email ?? "").toLowerCase();
  const parts = name.split(/\s+/);
  return parts[parts.length - 1]!.toLowerCase();
}

/**
 * By surname, then by display name. Returns a NEW array: the client component
 * holds one roster across every keystroke, and sorting in place would reorder the
 * source under it.
 */
export function sortRoster<T extends RosterRow>(rows: T[]): T[] {
  return [...rows].sort(
    (a, b) =>
      lastNameKey(a).localeCompare(lastNameKey(b)) ||
      (a.name ?? a.email).localeCompare(b.name ?? b.email),
  );
}

/**
 * The filters a URL is carrying. The search is lowercased and trimmed HERE rather
 * than at the point of comparison, so a URL holding "  Ada " and one holding "ada"
 * are the same filter and the address bar cannot disagree with the table.
 */
export function rosterFiltersFromParams(params: URLSearchParams): RosterFilters {
  return {
    q: (params.get("q") ?? "").trim().toLowerCase(),
    role: params.get("role") ?? "",
    team: params.get("team") ?? "",
    manager: params.get("manager") ?? "",
    bookable: params.get("bookable") ?? "",
  };
}

/** The query string for these filters, omitting every one that is not set. */
export function rosterFiltersToQuery(f: RosterFilters): string {
  const params = new URLSearchParams();
  for (const key of ["q", "role", "team", "manager", "bookable"] as const) {
    if (f[key]) params.set(key, f[key]);
  }
  return params.toString();
}
