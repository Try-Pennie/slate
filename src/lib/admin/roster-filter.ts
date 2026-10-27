import { isActive } from "@/lib/active-user";
import { matchesSearchQuery, normalizeSearchQuery } from "@/lib/search-query";
import { teamsOf } from "@/lib/admin/agent-display";
import { isNeverSignedIn } from "@/lib/admin/unclaimed";
import { awaitingFirstRead, needsPhoto as needsDirectoryPhoto, type AdvisorPhoto } from "@/lib/advisor-photos/resolve";
import type { User } from "@/lib/db/types";
import { isRealAdvisor } from "@/lib/advisors/real-advisor";
import {
  BOOKABLE_STATES,
  bookableStateOf,
  heldByTwilio,
  type BookableState,
} from "@/lib/bookable/bookable-state";

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
  | "auth_user_id"
  | "created_at"
  | "is_test"
> & {
  /** The placeholder advisor (#4201), off the roster like a test row; absent reads as false. */
  is_placeholder?: boolean;
  /**
   * The state of this agent's working hours (#1802). Absent or null when the
   * page could not read the schedules, in which case the page offers no hours
   * column and no hours filter rather than a guess.
   */
  hours?: RosterHours | null;
  /**
   * The person's picture as `resolveAdvisorPhoto` judged it (#3027): the server
   * resolves it once, so the roster never reads `avatar_url` itself.
   */
  photo: AdvisorPhoto;
};

/**
 * The state of an agent's working hours, as the roster shows it.
 *
 *   seeded  still the org's default week, which nobody chose (`isUnsetHours`,
 *           the predicate the unset hours alert and the activation import use)
 *   set     a week somebody chose: the agent, an admin, or the cal.com import
 *   none    no schedule, or one with no days in it
 *
 * Deliberately a separate fact from sign in: somebody can sign in and never set
 * hours, and an admin or the import can set hours for somebody who never logs in.
 */
export type RosterHours = "seeded" | "set" | "none";
export const ROSTER_HOURS: readonly RosterHours[] = ["seeded", "set", "none"] as const;

/** Each hours state in the roster's words. One place, so a cell and the picker agree. */
export function rosterHoursText(h: RosterHours): string {
  switch (h) {
    case "seeded":
      return "Seeded default";
    case "set":
      return "Set";
    case "none":
      return "None";
  }
}

/** The sign in filter's values, "" meaning any. */
export const ROSTER_SIGNIN = ["never", "yes"] as const;
export type RosterSignin = (typeof ROSTER_SIGNIN)[number];

/**
 * The photo filter's values, "" meaning any (#2837, #3027). Three, so the views
 * between them cover every row (L45):
 *
 *   needed  the Google directory was read and holds no photo for them
 *   has     Slate holds their directory photo
 *   unread  the daily refresh has not reached them, or the photos could not be
 *           read at all; neither is evidence about the person
 */
export const ROSTER_PHOTO = ["needed", "has", "unread"] as const;
export type RosterPhoto = (typeof ROSTER_PHOTO)[number];

/**
 * Whether this person needs a photo added in Google (#2837). A fact of its own,
 * never folded into sign in, and keyed on the directory's MEASURED answer only.
 */
export function needsPhoto(u: Pick<RosterRow, "photo">): boolean {
  return needsDirectoryPhoto(u.photo);
}

/**
 * Which photo filter value a row answers to. Exactly one, for every row.
 *
 * "unread" never holds a deactivated person the refresh skips (#3161):
 * `filterRoster` drops offboarded rows before any filter is consulted.
 */
export function rosterPhotoState(u: Pick<RosterRow, "photo">): RosterPhoto {
  if (u.photo.kind === "none") return "needed";
  if (u.photo.kind === "photo") return "has";
  return "unread";
}

/**
 * The roster's one sentence about photos it cannot vouch for (#3027), said once
 * above the table rather than on every row: before the first daily refresh that
 * is every row, and a marker repeated 136 times is a wall nobody reads (L579).
 * Null when there is nothing to say.
 *
 * It counts only people the refresh covers (#3161). The page resolves every
 * user, deactivated ones included, and a deactivated person is never read, so
 * counting them named a gap the Refresh button beside it could not close.
 */
export function rosterPhotoNotice(rows: Pick<RosterRow, "photo" | "deactivated_at">[]): string | null {
  if (rows.some((r) => r.photo.kind === "unreadable")) {
    return "Photos could not be read, so each person shows the photo from their own sign in, if any. Reload in a moment.";
  }
  const unread = rows.filter((r) => awaitingFirstRead(r.photo, r)).length;
  if (unread === 0) return null;
  return `${unread === 1 ? "1 person has" : `${unread} people have`} not had their photo read from Google yet, so they show the photo from their own sign in, if any.`;
}

/**
 * The marker on a row with no photo. It names the remedy rather than the gap:
 * Slate takes the photo from Google, so it is the person who adds one there.
 */
export const ROSTER_NEEDS_PHOTO_TEXT = "Needs a photo in Google";

export interface RosterFilters {
  /**
   * The search text. Normalised on the way out of a URL, and normalised again by
   * `filterRoster`: a caller that builds filters by hand and passes "Ada" would
   * otherwise match nothing at all, with no error anywhere, which is a wrong
   * answer that reads exactly like a correct empty one.
   *
   * A TRAILING space is part of the filter and is not stripped (#1791): it is
   * how the person says "this is the whole word". See `@/lib/search-query`.
   */
  q: string;
  role: string;
  team: string;
  manager: string;
  /** "" any, or one `BookableState`: "yes", "no" or "redistribute" (#3030) */
  bookable: "" | BookableState;
  /** "" any · "never" (no linked Google sign in) · "yes" (#1802) */
  signin: "" | RosterSignin;
  /** "" any, or one `RosterHours` (#1802) */
  hours: "" | RosterHours;
  /** "" any, or one `RosterPhoto` (#2837) */
  photo: "" | RosterPhoto;
}

/** Rows per rendered page, so the DOM stays bounded as the roster grows (#94). */
export const ROSTER_PAGE_SIZE = 50;

export const EMPTY_ROSTER_FILTERS: RosterFilters = {
  q: "",
  role: "",
  team: "",
  manager: "",
  bookable: "",
  signin: "",
  hours: "",
  photo: "",
};

export function hasAnyRosterFilter(f: RosterFilters): boolean {
  // The search is judged NORMALISED, so a box holding only spaces is not a
  // filter. Otherwise the table would show everyone while the surface offered a
  // Clear button for a filter doing nothing.
  return Boolean(
    normalizeSearchQuery(f.q) ||
      f.role ||
      f.team ||
      f.manager ||
      f.bookable ||
      f.signin ||
      f.hours ||
      f.photo,
  );
}

/**
 * Whether a row is on the roster at all: not offboarded, and a real advisor, so
 * neither a synthetic test row (#396) nor the placeholder (#4201). The page already
 * reads only real advisors; this says so here too, so the filter, the roster's size
 * and the never signed in count are one population however the rows arrived (#1802).
 */
export function onRoster(u: Pick<RosterRow, "deactivated_at" | "is_test" | "is_placeholder">): boolean {
  return isActive(u) && isRealAdvisor(u);
}

/**
 * Everyone still on the roster who matches every filter that is set.
 *
 * Offboarded people are excluded first and unconditionally: they are not on the
 * roster at all, so no filter may bring one back.
 */
export function filterRoster<T extends RosterRow>(rows: T[], f: RosterFilters): T[] {
  const needle = normalizeSearchQuery(f.q);
  return rows.filter((u) => {
    if (!onRoster(u)) return false;
    if (f.role && u.role !== f.role) return false;
    // #3030: by the state the Bookable column SHOWS, so "Not bookable" never
    // returns a row the column calls Redistribute.
    if (f.bookable && bookableStateOf(u.bookable, heldByTwilio(u)) !== f.bookable) return false;
    if (f.team && !teamsOf(u).includes(f.team)) return false;
    if (f.manager && u.manager_id !== f.manager) return false;
    // The linked sign in, never the photo (#1802, #2600).
    if (f.signin === "never" && !isNeverSignedIn(u)) return false;
    if (f.signin === "yes" && isNeverSignedIn(u)) return false;
    if (f.hours && u.hours !== f.hours) return false;
    // Its own fact, independent of sign in (#2837).
    if (f.photo && rosterPhotoState(u) !== f.photo) return false;
    // Name and email as SEPARATE fields, never joined (#1791). The old join
    // inserted a space no record holds, which a query with a space could match
    // across.
    if (!matchesSearchQuery(needle, u.name, u.email)) return false;
    return true;
  });
}

/**
 * What the table says when it has no rows to show.
 *
 * Four different states, said four different ways (L10, L11). The one that
 * matters is the search: now that a trailing space filters (#1791), an
 * ACCIDENTAL one empties the table for a reason nobody can see, because a space
 * is invisible. So the query is QUOTED, and the quotes are what make the space
 * visible. It is quoted in its NORMALISED form, or the sentence would show a
 * query that is not the one the rows were matched against.
 */
export function rosterEmptyText(f: RosterFilters): string {
  const q = normalizeSearchQuery(f.q);
  const others = Boolean(
    f.role || f.team || f.manager || f.bookable || f.signin || f.hours || f.photo,
  );
  if (q) return others ? `Nothing matches "${q}" with those filters.` : `Nothing matches "${q}".`;
  if (others) return "Nobody on the roster matches those filters.";
  return "No agents yet.";
}

/**
 * The roster's result count, in words (#1799).
 *
 * It used to read "showing 1 to 5 of 5 (of 136)": three numbers, two of them the
 * same, and a parenthetical whose meaning the reader had to work out. Two facts
 * are worth having, so at most two numbers appear and never the same one twice.
 *
 * THE PAGE RANGE IS DELIBERATELY ABSENT. The pager below the table already says
 * "Page 1 of 3", and only when there is more than one page, so putting the range
 * here too is one fact printed twice on one screen. What is left is the only
 * question this line can answer that nothing else does: how many matched, out of
 * how many there are.
 *
 * It is read into a live region on every keystroke, which is why the empty cases
 * are terse and do not repeat what `rosterEmptyText` says in the table itself.
 */
export function rosterCountText(counts: {
  matched: number;
  total: number;
  filtered: boolean;
  /**
   * How many on the roster have never signed in (#1802). Said beside the total
   * only when nothing is filtered: it is a fact about the whole roster, and
   * under the sign in filter the matched figure already is this number.
   */
  neverSignedIn?: number;
}): string {
  const { matched, total, filtered, neverSignedIn } = counts;
  // An empty roster is already stated by the table directly underneath. Saying it
  // again in a live region announces one fact twice.
  if (total === 0) return "";
  if (filtered && matched === 0) return "No matches";
  const agents = (n: number) => `${n} agent${n === 1 ? "" : "s"}`;
  // Equal counts carry one fact, so they print as one number. That covers the
  // unfiltered case and a filter that happens to match everyone.
  if (matched !== total) return `${matched} of ${agents(total)}`;
  if (filtered || neverSignedIn === undefined) return agents(total);
  return neverSignedIn === 0
    ? `${agents(total)}, all signed in`
    : `${agents(total)}, ${neverSignedIn} never signed in`;
}

/**
 * Everyone on the roster who has never signed in: active, not a test row, and no
 * linked Google sign in. The same population `filterRoster` shows under the sign
 * in filter, since both read `onRoster` and `isNeverSignedIn`.
 */
export function neverSignedInCount(rows: RosterRow[]): number {
  return rows.filter((u) => onRoster(u) && isNeverSignedIn(u)).length;
}

/**
 * The Signed in cell: "Yes" or "Never". No day count (Dan, 2026-10-02): how long
 * a row has waited is the pending access panel's question, not the roster's.
 */
export function rosterSigninText(u: Pick<RosterRow, "auth_user_id">): string {
  return isNeverSignedIn(u) ? "Never" : "Yes";
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
 * The filters a URL is carrying.
 *
 * The search is normalised HERE rather than at the point of comparison, so a URL
 * holding "  Ada" and one holding "ada" are the same filter and the address bar
 * cannot disagree with the table. Only the LEADING space is dropped: a trailing
 * one is the filter (#1791), so it survives the round trip in both directions.
 */
export function rosterFiltersFromParams(params: URLSearchParams): RosterFilters {
  return {
    q: normalizeSearchQuery(params.get("q") ?? ""),
    role: params.get("role") ?? "",
    team: params.get("team") ?? "",
    manager: params.get("manager") ?? "",
    bookable: oneOf(BOOKABLE_STATES, params.get("bookable")),
    // Only a value the picker offers. A hand edited URL would otherwise be a
    // filter matching nobody for a reason no control on the page shows.
    signin: oneOf(ROSTER_SIGNIN, params.get("signin")),
    hours: oneOf(ROSTER_HOURS, params.get("hours")),
    photo: oneOf(ROSTER_PHOTO, params.get("photo")),
  };
}

function oneOf<T extends string>(allowed: readonly T[], v: string | null): "" | T {
  return v !== null && (allowed as readonly string[]).includes(v) ? (v as T) : "";
}

/** The query string for these filters, omitting every one that is not set. */
export function rosterFiltersToQuery(f: RosterFilters): string {
  const params = new URLSearchParams();
  for (const key of ["q", "role", "team", "manager", "bookable", "signin", "hours", "photo"] as const) {
    if (f[key]) params.set(key, f[key]);
  }
  return params.toString();
}
