import { describe, it, expect } from "vitest";
import {
  ROSTER_PAGE_SIZE,
  filterRoster,
  sortRoster,
  rosterFiltersFromParams,
  rosterFiltersToQuery,
  hasAnyRosterFilter,
  type RosterFilters,
  type RosterRow,
} from "@/lib/admin/roster-filter";

// #1752: typing a name into the agent search and pressing Search used to navigate,
// re-render the whole force-dynamic admin page and re-run about a dozen database
// queries, in order to run a substring match over 136 strings the browser was
// already holding.
//
// Moving that into the browser splits one predicate across two runtimes, which is
// the shape where the two quietly stop agreeing. So the predicate lives here, is
// pure, and both the server's no-JavaScript path and the client component call
// THIS. These tests are what make that sharing worth anything.

const row = (o: Partial<RosterRow> & { id: string }): RosterRow => ({
  name: null,
  avatar_url: null,
  email: `${o.id}@x.com`,
  role: "agent",
  bookable: true,
  manager_id: null,
  deactivated_at: null,
  attributes: {},
  ...o,
});

const ROSTER: RosterRow[] = [
  row({ id: "a", name: "Ada Lovelace", email: "ada@x.com", role: "agent", attributes: { debt_team: ["credit"] } }),
  row({ id: "b", name: "Grace Hopper", email: "grace@x.com", role: "manager", bookable: false, manager_id: "a", attributes: { debt_team: "medical" } }),
  row({ id: "c", name: "Alan Turing", email: "alan@x.com", role: "admin", attributes: { debt_team: ["credit", "medical"] } }),
  row({ id: "d", name: "Gone Person", email: "gone@x.com", deactivated_at: "2026-01-01T00:00:00Z" }),
];

const NONE: RosterFilters = { q: "", role: "", team: "", manager: "", bookable: "" };

describe("filterRoster", () => {
  it("hides anyone offboarded, whatever else is asked for", () => {
    // An offboarded person is not on the roster at all; a filter must not be able
    // to bring them back.
    for (const f of [NONE, { ...NONE, q: "gone" }, { ...NONE, role: "agent" }]) {
      expect(filterRoster(ROSTER, f).map((u) => u.id)).not.toContain("d");
    }
  });

  it("matches the search against the name and the email, case insensitively", () => {
    expect(filterRoster(ROSTER, { ...NONE, q: "LOVE" }).map((u) => u.id)).toEqual(["a"]);
    expect(filterRoster(ROSTER, { ...NONE, q: "grace@" }).map((u) => u.id)).toEqual(["b"]);
  });

  it("matches on email alone for somebody with no name", () => {
    const anon = [row({ id: "z", name: null, email: "zed@x.com" })];
    expect(filterRoster(anon, { ...NONE, q: "zed" })).toHaveLength(1);
  });

  it("filters by role", () => {
    expect(filterRoster(ROSTER, { ...NONE, role: "manager" }).map((u) => u.id)).toEqual(["b"]);
  });

  it("reads a team stored as an array and as a bare string", () => {
    // debt_team is an array on most agents and a bare string on a few. Handling
    // one shape drops every agent with the other, and a roster filter that
    // silently omits people is worse than one that refuses.
    expect(filterRoster(ROSTER, { ...NONE, team: "medical" }).map((u) => u.id)).toEqual(["b", "c"]);
    expect(filterRoster(ROSTER, { ...NONE, team: "credit" }).map((u) => u.id)).toEqual(["a", "c"]);
  });

  it("filters by manager", () => {
    expect(filterRoster(ROSTER, { ...NONE, manager: "a" }).map((u) => u.id)).toEqual(["b"]);
  });

  it("filters by bookable, in both directions", () => {
    expect(filterRoster(ROSTER, { ...NONE, bookable: "yes" }).map((u) => u.id)).toEqual(["a", "c"]);
    expect(filterRoster(ROSTER, { ...NONE, bookable: "no" }).map((u) => u.id)).toEqual(["b"]);
  });

  it("applies every named filter together, not whichever is last", () => {
    expect(
      filterRoster(ROSTER, { ...NONE, team: "medical", bookable: "yes" }).map((u) => u.id),
    ).toEqual(["c"]);
  });

  it("returns everyone active when nothing is asked for", () => {
    expect(filterRoster(ROSTER, NONE).map((u) => u.id)).toEqual(["a", "b", "c"]);
  });
});

describe("sortRoster", () => {
  it("orders by surname, then by display name", () => {
    expect(sortRoster(filterRoster(ROSTER, NONE)).map((u) => u.name)).toEqual([
      "Grace Hopper",
      "Ada Lovelace",
      "Alan Turing",
    ]);
  });

  it("falls back to the email when somebody has no name", () => {
    const mixed = [row({ id: "z", name: null, email: "aaa@x.com" }), row({ id: "y", name: "Zoe Zed" })];
    expect(sortRoster(mixed).map((u) => u.id)).toEqual(["z", "y"]);
  });

  it("does not mutate what it is given", () => {
    // The client component holds one roster array across every keystroke; a sort
    // in place would reorder the source and make the next render disagree.
    const input = filterRoster(ROSTER, NONE);
    const before = input.map((u) => u.id);
    sortRoster(input);
    expect(input.map((u) => u.id)).toEqual(before);
  });
});

describe("the URL and the filters are one round trip", () => {
  it("reads every filter back out of the params it wrote", () => {
    const f: RosterFilters = { q: "ada", role: "agent", team: "credit", manager: "m1", bookable: "yes" };
    expect(rosterFiltersFromParams(new URLSearchParams(rosterFiltersToQuery(f)))).toEqual(f);
  });

  it("writes nothing for a filter that is not set, so a bare URL stays bare", () => {
    expect(rosterFiltersToQuery(NONE)).toBe("");
  });

  it("lowercases and trims the search on the way in, which is what the match uses", () => {
    // The predicate compares lowercased, so a filter carrying "  Ada " and one
    // carrying "ada" have to be the same filter, or the URL and the table
    // disagree about what is being shown.
    expect(rosterFiltersFromParams(new URLSearchParams("q=%20%20Ada%20")).q).toBe("ada");
  });

  it("reads a missing param as unset rather than as a filter for the empty string", () => {
    expect(rosterFiltersFromParams(new URLSearchParams(""))).toEqual(NONE);
  });
});

describe("hasAnyRosterFilter", () => {
  it("is false for nothing set", () => {
    expect(hasAnyRosterFilter(NONE)).toBe(false);
  });

  it("is true for each filter on its own, so none of them is silently ignored", () => {
    for (const key of ["q", "role", "team", "manager", "bookable"] as const) {
      expect(hasAnyRosterFilter({ ...NONE, [key]: "x" })).toBe(true);
    }
  });
});

describe("the page size", () => {
  it("is a positive whole number the table and the pager both read", () => {
    expect(Number.isInteger(ROSTER_PAGE_SIZE)).toBe(true);
    expect(ROSTER_PAGE_SIZE).toBeGreaterThan(0);
  });
});
