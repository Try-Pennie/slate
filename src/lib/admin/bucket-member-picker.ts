import type { Role } from "@/lib/db/types";
import { matchesSearchQuery, normalizeSearchQuery } from "@/lib/search-query";

/**
 * The pure half of the bucket editor's manual members picker (#1760).
 *
 * Kept out of the component so the matching and grouping rules can be driven by
 * `scripts/test-bucket-member-picker.ts` without a DOM, and so the page's server
 * render and the browser's filtering share ONE predicate rather than two that
 * can drift (L370).
 */

/**
 * One person as the picker needs them.
 *
 * Deliberately a PROJECTION of `User`, not the row: the page hands the whole
 * roster to a client component, so every field on it crosses to the browser and
 * ends up in the RSC payload. Three strings per person is what the picker can
 * actually draw.
 */
export interface RosterEntry {
  id: string;
  /** Display name; "" for a user whose `name` is null (the email carries them). */
  name: string;
  email: string;
  /** Which labelled block this person is listed under. */
  section: string;
}

export interface RosterSection {
  section: string;
  entries: RosterEntry[];
}

/**
 * The order sections are drawn in, agents first because a routing pool is a pool
 * of agents and everyone else in the list is an exception.
 *
 * This ordering is also the seam #1762 needs. That issue decides whether departed
 * and non bookable people are dropped from the list outright or shown labelled and
 * unpickable; either answer is a change to `rosterSectionFor` plus one entry here,
 * with nothing to restructure. It is deliberately NOT decided here.
 */
export const ROSTER_SECTION_ORDER: readonly string[] = [
  "Agents",
  "Managers",
  "Team leads",
  "Admins",
  // #4205: last, because a coordinator is never routed a call. The bucket page
  // reads real advisors only, which leaves them out; this is the section they would
  // fall under if a read ever did not.
  "Coordinators",
];

/**
 * Which section a role is listed under. A `Record<Role, string>` on purpose, so
 * `tsc` names a role nobody placed rather than letting it fall to a default,
 * which is indistinguishable from a deliberate choice (L113).
 */
const SECTION_BY_ROLE: Record<Role, string> = {
  coordinator: "Coordinators",
  agent: "Agents",
  manager: "Managers",
  team_lead: "Team leads",
  admin: "Admins",
  super_admin: "Admins",
};

export function rosterSectionFor(role: Role): string {
  return SECTION_BY_ROLE[role];
}

/**
 * Does this person match the search box?
 *
 * A blank or whitespace-only query matches EVERYONE, because that is the "no
 * search yet" state rather than a search that found nobody. The two must stay
 * distinguishable: the picker draws a "nobody matches" line for the second and
 * the whole roster for the first.
 */
export function matchesRosterQuery(entry: RosterEntry, query: string): boolean {
  // One shared rule for every search box (#1791): a trailing space is the word
  // boundary and is kept, a leading one is noise, and whitespace alone is the
  // "no search yet" state the docstring above turns on.
  return matchesSearchQuery(normalizeSearchQuery(query), entry.name, entry.email);
}

/** Sort key: the display name, falling back to the email for a nameless user. */
const sortLabel = (e: RosterEntry): string => (e.name || e.email).toLowerCase();

/**
 * The roster the picker should render for `query`: ordered sections, alphabetical
 * inside each, and a section with no matches DROPPED rather than drawn empty.
 *
 * Dropping is what makes the picker cheap. With a query typed, only matching rows
 * exist in the DOM at all, so the rendered control count stops scaling with the
 * roster (the #1760 measurement: 8,820 `<input>` elements at 60 buckets times 136
 * people, because every bucket drew every person as a checkbox).
 */
export function rosterSections(
  entries: RosterEntry[],
  query: string,
): RosterSection[] {
  const matched = entries.filter((e) => matchesRosterQuery(e, query));
  const bySection = new Map<string, RosterEntry[]>();
  for (const e of matched) {
    const list = bySection.get(e.section);
    if (list) list.push(e);
    else bySection.set(e.section, [e]);
  }
  const known = ROSTER_SECTION_ORDER.filter((s) => bySection.has(s));
  // A section nobody declared still gets drawn, after the declared ones, rather
  // than having its people silently vanish from the list.
  const extra = [...bySection.keys()]
    .filter((s) => !ROSTER_SECTION_ORDER.includes(s))
    .sort();
  return [...known, ...extra].map((section) => ({
    section,
    entries: (bySection.get(section) ?? [])
      .slice()
      .sort((a, b) => sortLabel(a).localeCompare(sortLabel(b))),
  }));
}

/** Flatten ordered sections into the option order the arrow keys walk. */
export function rosterOptionOrder(sections: RosterSection[]): RosterEntry[] {
  return sections.flatMap((s) => s.entries);
}
