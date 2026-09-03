import { describe, it, expect } from "vitest";
import {
  ROSTER_PAGE_SIZE,
  filterRoster,
  sortRoster,
  rosterFiltersFromParams,
  rosterFiltersToQuery,
  hasAnyRosterFilter,
  rosterEmptyText,
  rosterCountText,
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

  it("lowercases and trims only the LEADING space, keeping the trailing one", () => {
    // #1791 reversed half of this deliberately. The old rule trimmed both ends so
    // the URL and the table could not disagree, but a TRAILING space is the only
    // way to say "this is the whole word" and Dan asked for it to mean that. A
    // LEADING space is noise from a paste, so that half stands.
    expect(rosterFiltersFromParams(new URLSearchParams("q=%20%20Ada%20")).q).toBe("ada ");
    expect(rosterFiltersFromParams(new URLSearchParams("q=%20%20Ada")).q).toBe("ada");
    // A query that is only whitespace is no search at all, not a search for a space.
    expect(rosterFiltersFromParams(new URLSearchParams("q=%20%20%20")).q).toBe("");
  });

  it("carries a trailing space through the URL round trip intact", () => {
    // The space is the filter. If it is lost on either leg, the table shows one
    // thing and the address bar means another.
    const q = rosterFiltersToQuery({ ...NONE, q: "john " });
    expect(rosterFiltersFromParams(new URLSearchParams(q)).q).toBe("john ");
  });

  it("reads a missing param as unset rather than as a filter for the empty string", () => {
    expect(rosterFiltersFromParams(new URLSearchParams(""))).toEqual(NONE);
  });
});

// #1791, Dan: "spaces should be counted in text matching. this should show me
// nothing. \"John \" should show me john kite and sullivan but not anybody with
// the last name johnson".
describe("a space in the search means a space", () => {
  // Its own roster: two Johns whose first name ENDS, and a Johnson whose does
  // not, so a trailing space can tell them apart. Kept separate from ROSTER so
  // the exact-id assertions above keep meaning what they were written to mean.
  const JOHNS: RosterRow[] = [
    row({ id: "jk", name: "John Kite", email: "jkite@x.com" }),
    row({ id: "js", name: "John Sullivan", email: "jsullivan@x.com" }),
    row({ id: "aj", name: "Andrew Johnson", email: "ajohnson@x.com" }),
  ];
  const ids = (q: string) => filterRoster(JOHNS, { ...NONE, q }).map((u) => u.id);

  it("treats a trailing space as the end of the word", () => {
    expect(ids("john ")).toEqual(["jk", "js"]);
  });

  it("does not match a surname that continues past the query", () => {
    // "john" is followed by "s" in Johnson, so the space cannot match.
    expect(ids("john ")).not.toContain("aj");
    // The control: without the space, every John and Johnson matches, so the
    // exclusion above is the space working and not the row being absent (L98).
    expect(ids("john")).toEqual(["jk", "js", "aj"]);
  });

  it("matches nobody for a double space, since no record holds one", () => {
    expect(ids("john  ")).toEqual([]);
  });

  it("never matches across the gap between a name and an email", () => {
    // The old haystack joined the two fields with a space that exists in no
    // record. Invisible while spaces were stripped; a false match the moment
    // they count. Name and email are matched separately, so this cannot happen.
    expect(ids("kite jkite")).toEqual([]);
    // The control: each half really does match on its own field.
    expect(ids("kite")).toEqual(["jk"]);
    expect(ids("jkite")).toEqual(["jk"]);
  });

  it("ignores a leading space, which is a paste rather than an instruction", () => {
    expect(ids(" john")).toEqual(["jk", "js", "aj"]);
  });

  it("reads a query of only spaces as no search at all", () => {
    // Not "a search that found nobody": those are different screens (L10).
    expect(ids("   ")).toEqual(filterRoster(JOHNS, NONE).map((u) => u.id));
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

// #1791: once a trailing space filters, an ACCIDENTAL one empties the table for
// a reason nobody can see, because a space is invisible. That is the cost of the
// feature working rather than an argument against it, so the empty state has to
// name the query with the space inside quotes where it can be seen.
describe("rosterEmptyText", () => {
  it("quotes the query so an invisible trailing space becomes visible", () => {
    expect(rosterEmptyText({ ...NONE, q: "john " })).toBe('Nothing matches "john ".');
  });

  it("says which other filters are in play when there are some", () => {
    expect(rosterEmptyText({ ...NONE, q: "john ", role: "agent" })).toBe(
      'Nothing matches "john " with those filters.',
    );
  });

  it("does not quote a query when there is none, and names the filters instead", () => {
    expect(rosterEmptyText({ ...NONE, role: "agent" })).toBe(
      "Nobody on the roster matches those filters.",
    );
  });

  it("says the roster is empty only when nothing is filtered at all", () => {
    // An empty roster and a filter that found nobody are different screens (L10).
    expect(rosterEmptyText(NONE)).toBe("No agents yet.");
  });

  it("treats a whitespace-only query as no query, so it never quotes a blank", () => {
    expect(rosterEmptyText({ ...NONE, q: "   " })).toBe("No agents yet.");
  });

  it("normalises the query it quotes, so the sentence matches what was matched", () => {
    // A leading space is dropped by the filter, so quoting it back would show a
    // query nobody searched for.
    expect(rosterEmptyText({ ...NONE, q: "  John " })).toBe('Nothing matches "john ".');
  });
});

// #1799: the count read "showing 1 to 5 of 5 (of 136)". Three numbers, two of
// them the same, and a parenthetical whose meaning had to be worked out.
describe("rosterCountText", () => {
  it("says how many matched out of the whole roster when a filter is on", () => {
    expect(rosterCountText({ matched: 5, total: 136, filtered: true })).toBe("5 of 136 agents");
  });

  it("never prints the same number twice", () => {
    // A filter that happens to match everyone. "136 of 136" is the defect in
    // miniature: two numbers carrying one fact.
    expect(rosterCountText({ matched: 136, total: 136, filtered: true })).toBe("136 agents");
  });

  it("gives the total alone when nothing is filtered", () => {
    expect(rosterCountText({ matched: 136, total: 136, filtered: false })).toBe("136 agents");
  });

  it("says no matches when a filter found nobody", () => {
    // Its own sentence, and deliberately not the quoted query: the table below
    // carries that, and this is a live region read out on every keystroke.
    expect(rosterCountText({ matched: 0, total: 136, filtered: true })).toBe("No matches");
  });

  it("says nothing at all for an empty roster", () => {
    // The table already says "No agents yet." directly underneath. This is a live
    // region, so repeating it would announce the same fact twice.
    expect(rosterCountText({ matched: 0, total: 0, filtered: false })).toBe("");
    expect(rosterCountText({ matched: 0, total: 0, filtered: true })).toBe("");
  });

  it("counts one agent in the singular", () => {
    expect(rosterCountText({ matched: 1, total: 1, filtered: false })).toBe("1 agent");
    expect(rosterCountText({ matched: 1, total: 136, filtered: true })).toBe("1 of 136 agents");
  });

  it("carries at most two numbers, in every combination", () => {
    // The rule the issue is actually about, asserted over the space rather than
    // at the five points above, so a later edit cannot reintroduce a third.
    for (const total of [0, 1, 5, 50, 136]) {
      for (const matched of [0, 1, 5, 50, 136]) {
        if (matched > total) continue;
        for (const filtered of [true, false]) {
          const text = rosterCountText({ matched, total, filtered });
          const numbers = text.match(/\d+/g) ?? [];
          expect(numbers.length, `"${text}"`).toBeLessThanOrEqual(2);
          expect(new Set(numbers).size, `"${text}" repeats a number`).toBe(numbers.length);
        }
      }
    }
  });
});

describe("the page size", () => {
  it("is a positive whole number the table and the pager both read", () => {
    expect(Number.isInteger(ROSTER_PAGE_SIZE)).toBe(true);
    expect(ROSTER_PAGE_SIZE).toBeGreaterThan(0);
  });
});
