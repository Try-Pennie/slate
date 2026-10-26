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
  neverSignedInCount,
  rosterSigninText,
  rosterHoursText,
  needsPhoto,
  ROSTER_NEEDS_PHOTO_TEXT,
  ROSTER_PHOTO,
  rosterPhotoNotice,
  EMPTY_ROSTER_FILTERS,
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
  photo: { kind: "never-read", src: null },
  email: `${o.id}@x.com`,
  role: "agent",
  bookable: true,
  manager_id: null,
  deactivated_at: null,
  attributes: {},
  auth_user_id: "auth",
  created_at: "2026-09-01T00:00:00Z",
  is_test: false,
  ...o,
});

const ROSTER: RosterRow[] = [
  row({ id: "a", name: "Ada Lovelace", email: "ada@x.com", role: "agent", attributes: { debt_team: ["credit"] } }),
  row({ id: "b", name: "Grace Hopper", email: "grace@x.com", role: "manager", bookable: false, manager_id: "a", attributes: { debt_team: "medical" } }),
  row({ id: "c", name: "Alan Turing", email: "alan@x.com", role: "admin", attributes: { debt_team: ["credit", "medical"] } }),
  row({ id: "d", name: "Gone Person", email: "gone@x.com", deactivated_at: "2026-01-01T00:00:00Z" }),
];

const NONE: RosterFilters = EMPTY_ROSTER_FILTERS;

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

  it("keeps an advisor Twilio holds back out of No and under Redistribute (#3030)", () => {
    const rows = [
      ...ROSTER,
      row({ id: "h", name: "Held Back", bookable: false, attributes: { redistribute_tagged: "Y" } }),
      row({ id: "m", name: "Mark Only", bookable: false, attributes: { redistribute: "Y" } }),
      row({ id: "t", name: "Tagged Bookable", bookable: true, attributes: { redistribute_tagged: "Y" } }),
    ];
    expect(filterRoster(rows, { ...NONE, bookable: "redistribute" }).map((u) => u.id)).toEqual(["h"]);
    expect(filterRoster(rows, { ...NONE, bookable: "no" }).map((u) => u.id).sort()).toEqual(["b", "m"]);
    expect(filterRoster(rows, { ...NONE, bookable: "yes" }).map((u) => u.id).sort()).toEqual(["a", "c", "t"]);
  });

  it("drops a bookable value no picker offers, rather than matching nobody", () => {
    expect(rosterFiltersFromParams(new URLSearchParams("bookable=maybe")).bookable).toBe("");
    expect(rosterFiltersFromParams(new URLSearchParams("bookable=redistribute")).bookable).toBe("redistribute");
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
    const f: RosterFilters = { q: "ada", role: "agent", team: "credit", manager: "m1", bookable: "yes", signin: "never", hours: "seeded", photo: "needed" };
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

// #1802: "never signed in" is a recorded fact, `auth_user_id` being null, and it
// used to be readable only by accident from whose photo was missing. Since #2600
// photos come from the Workspace directory, so the photo says nothing at all.
describe("never signed in", () => {
  const NOW = Date.UTC(2026, 8, 28, 12, 0, 0);
  const ago = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
  const SIGNIN: RosterRow[] = [
    // Signed in, no photo: the case the avatar heuristic got wrong.
    row({ id: "s1", auth_user_id: "auth-1", photo: { kind: "none" } }),
    // Never signed in, photo from the directory backfill (#2600).
    row({ id: "n1", auth_user_id: null, photo: { kind: "photo", src: "/advisor-photo/x" }, created_at: ago(12) }),
    row({ id: "n2", auth_user_id: null, created_at: ago(0) }),
    row({ id: "s2", auth_user_id: "auth-2", photo: { kind: "photo", src: "/advisor-photo/x" } }),
    // Offboarded and test rows are not on the roster, so they are not counted.
    row({ id: "gone", auth_user_id: null, deactivated_at: ago(3) }),
    row({ id: "smoke", auth_user_id: null, is_test: true }),
  ];

  it("filters to the people with no linked sign in, whatever their photo", () => {
    expect(filterRoster(SIGNIN, { ...NONE, signin: "never" }).map((u) => u.id)).toEqual(["n1", "n2"]);
    expect(filterRoster(SIGNIN, { ...NONE, signin: "yes" }).map((u) => u.id)).toEqual(["s1", "s2"]);
  });

  it("counts exactly the active non test rows whose auth_user_id is null", () => {
    const direct = SIGNIN.filter((u) => u.auth_user_id === null && u.deactivated_at === null && !u.is_test).length;
    expect(neverSignedInCount(SIGNIN)).toBe(direct);
    expect(neverSignedInCount(SIGNIN)).toBe(2);
  });

  it("does not count somebody who signed in and has no photo", () => {
    expect(neverSignedInCount([row({ id: "s1", auth_user_id: "auth-1", photo: { kind: "none" } })])).toBe(0);
    expect(rosterSigninText(row({ id: "s1", auth_user_id: "auth-1", photo: { kind: "none" } }))).toBe("Yes");
  });

  // Dan, 2026-10-02: the roster says Never, with no day count.
  it("says Never for a row nobody has signed in to, however long it has waited", () => {
    expect(rosterSigninText(SIGNIN[1]!)).toBe("Never");
    expect(rosterSigninText(SIGNIN[2]!)).toBe("Never");
  });

  it("carries the new filters through the URL and counts them as filters", () => {
    const f: RosterFilters = { ...NONE, signin: "never", hours: "seeded" };
    expect(rosterFiltersFromParams(new URLSearchParams(rosterFiltersToQuery(f)))).toEqual(f);
    expect(hasAnyRosterFilter({ ...NONE, signin: "never" })).toBe(true);
    expect(hasAnyRosterFilter({ ...NONE, hours: "none" })).toBe(true);
    expect(rosterEmptyText({ ...NONE, signin: "never" })).toBe("Nobody on the roster matches those filters.");
  });

  it("refuses a value outside the picker's list rather than filtering on it", () => {
    // A hand edited URL must not become a filter that matches nobody for a reason
    // nobody can see in the picker.
    const f = rosterFiltersFromParams(new URLSearchParams("signin=maybe&hours=whenever"));
    expect(f.signin).toBe("");
    expect(f.hours).toBe("");
  });

  it("puts the never signed in count beside the total, once, only when nothing is filtered", () => {
    expect(rosterCountText({ matched: 130, total: 130, filtered: false, neverSignedIn: 41 })).toBe(
      "130 agents, 41 never signed in",
    );
    expect(rosterCountText({ matched: 130, total: 130, filtered: false, neverSignedIn: 0 })).toBe(
      "130 agents, all signed in",
    );
    // Filtered to never signed in, the matched figure IS the count: saying it again
    // would print one fact twice on one line (L605).
    expect(rosterCountText({ matched: 41, total: 130, filtered: true, neverSignedIn: 41 })).toBe("41 of 130 agents");
  });
});

// Working hours still on the seeded default are a SEPARATE fact from sign in:
// somebody can sign in and never set hours, and hours can be set for somebody by
// an admin or the cal.com import before they ever log in.
describe("working hours state", () => {
  const H: RosterRow[] = [
    row({ id: "seed", hours: "seeded" }),
    row({ id: "set", hours: "set" }),
    row({ id: "none", hours: "none" }),
    row({ id: "never-set", auth_user_id: null, hours: "set" }),
  ];

  it("filters on the hours state independently of sign in", () => {
    expect(filterRoster(H, { ...NONE, hours: "seeded" }).map((u) => u.id)).toEqual(["seed"]);
    expect(filterRoster(H, { ...NONE, hours: "set" }).map((u) => u.id)).toEqual(["set", "never-set"]);
    expect(filterRoster(H, { ...NONE, hours: "set", signin: "never" }).map((u) => u.id)).toEqual(["never-set"]);
  });

  it("names each state in its own words", () => {
    const words = (["seeded", "set", "none"] as const).map(rosterHoursText);
    expect(new Set(words).size).toBe(3);
    expect(rosterHoursText("seeded")).toBe("Seeded default");
  });
});

// #2837, #3027: a missing Google photo is its OWN fact, never folded into sign in,
// and it is the directory's MEASURED "none" only: a person the daily refresh has not
// reached, or a table Slate could not read, is not evidence anybody needs a photo.
describe("needs a photo", () => {
  const P: RosterRow[] = [
    // Signed in, no photo in the directory: needs a photo, and is still signed in.
    row({ id: "signed-nophoto", auth_user_id: "auth-1", photo: { kind: "none" } }),
    // Never signed in, photo from the directory: does NOT need one.
    row({ id: "never-photo", auth_user_id: null, photo: { kind: "photo", src: "/advisor-photo/a" } }),
    // Never signed in, no photo: both facts, independently.
    row({ id: "never-nophoto", auth_user_id: null, photo: { kind: "none" } }),
    // Not read yet, whatever their sign in photo: neither needs nor has.
    row({ id: "unread", photo: { kind: "never-read", src: "https://lh3.googleusercontent.com/a/x" } }),
    row({ id: "unreadable", photo: { kind: "unreadable", src: null } }),
    row({ id: "has", photo: { kind: "photo", src: "/advisor-photo/b" } }),
    // Offboarded and test rows are not on the roster, whatever their photo.
    row({ id: "gone", photo: { kind: "none" }, deactivated_at: "2026-01-01T00:00:00Z" }),
    row({ id: "smoke", photo: { kind: "none" }, is_test: true }),
    // #4201: nor is the placeholder advisor, the same rule the page's read applies.
    row({ id: "marcia", photo: { kind: "none" }, is_placeholder: true }),
  ];

  it("is the measured none, and only that", () => {
    expect(needsPhoto({ photo: { kind: "none" } })).toBe(true);
    expect(needsPhoto({ photo: { kind: "photo", src: "/advisor-photo/a" } })).toBe(false);
    expect(needsPhoto({ photo: { kind: "never-read", src: null } })).toBe(false);
    expect(needsPhoto({ photo: { kind: "unreadable", src: null } })).toBe(false);
  });

  it("puts every row in exactly one photo filter (L45)", () => {
    const on = P.filter((u) => u.deactivated_at === null && !u.is_test && !u.is_placeholder).map((u) => u.id);
    const views = (["needed", "has", "unread"] as const).map((photo) => filterRoster(P, { ...NONE, photo }).map((u) => u.id));
    expect(views.flat().sort()).toEqual([...on].sort());
    expect(new Set(views.flat()).size).toBe(views.flat().length);
    expect(ROSTER_PHOTO).toEqual(["needed", "has", "unread"]);
  });

  it("filters on the photo independently of sign in", () => {
    expect(filterRoster(P, { ...NONE, photo: "needed" }).map((u) => u.id)).toEqual(["signed-nophoto", "never-nophoto"]);
    expect(filterRoster(P, { ...NONE, photo: "has" }).map((u) => u.id)).toEqual(["never-photo", "has"]);
    expect(filterRoster(P, { ...NONE, photo: "unread" }).map((u) => u.id)).toEqual(["unread", "unreadable"]);
    // The two filters compose, so neither is secretly the other.
    expect(filterRoster(P, { ...NONE, photo: "needed", signin: "yes" }).map((u) => u.id)).toEqual(["signed-nophoto"]);
    expect(filterRoster(P, { ...NONE, photo: "needed", signin: "never" }).map((u) => u.id)).toEqual(["never-nophoto"]);
  });

  it("says once, above the table, what it cannot vouch for", () => {
    expect(rosterPhotoNotice([row({ id: "a", photo: { kind: "photo", src: "/advisor-photo/a" } })])).toBeNull();
    expect(rosterPhotoNotice([row({ id: "a" }), row({ id: "b" })])).toMatch(/^2 people have not had their photo read from Google yet/);
    expect(rosterPhotoNotice([row({ id: "a" })])).toMatch(/^1 person has not/);
    expect(rosterPhotoNotice([row({ id: "a", photo: { kind: "unreadable", src: null } })])).toMatch(/could not be read/);
  });

  it("counts only the people the refresh covers, so the button beside it can close the gap (#3161)", () => {
    const gone = (id: string) => row({ id, deactivated_at: "2026-09-01T00:00:00.000Z" });
    // A deactivated person with no record is never going to be read: nothing is said.
    expect(rosterPhotoNotice([gone("left")])).toBeNull();
    // An active one with no record still is, and still counts.
    expect(rosterPhotoNotice([row({ id: "a" })])).toMatch(/^1 person has not/);
    // Mixed: only the active ones are counted.
    expect(rosterPhotoNotice([row({ id: "a" }), row({ id: "b" }), gone("x"), gone("y"), gone("z")])).toMatch(/^2 people have not/);
    // A failed table read is about the table, so it is said whoever is on the page.
    expect(rosterPhotoNotice([row({ id: "left", deactivated_at: "2026-09-01T00:00:00.000Z", photo: { kind: "unreadable", src: null } })])).toMatch(/could not be read/);
    // The photo filter's "unread" view cannot hold them either: they are off the roster.
    expect(filterRoster([row({ id: "a" }), gone("left")], { ...NONE, photo: "unread" }).map((u) => u.id)).toEqual(["a"]);
  });

  it("carries the photo filter through the URL and counts it as a filter", () => {
    const f: RosterFilters = { ...NONE, photo: "needed" };
    expect(rosterFiltersToQuery(f)).toBe("photo=needed");
    expect(rosterFiltersFromParams(new URLSearchParams(rosterFiltersToQuery(f)))).toEqual(f);
    expect(hasAnyRosterFilter(f)).toBe(true);
    expect(rosterEmptyText(f)).toBe("Nobody on the roster matches those filters.");
    expect(rosterFiltersFromParams(new URLSearchParams("photo=maybe")).photo).toBe("");
  });

  it("words the marker as the remedy, which is the person's Google account", () => {
    expect(ROSTER_NEEDS_PHOTO_TEXT).toMatch(/photo/i);
    expect(ROSTER_NEEDS_PHOTO_TEXT).toMatch(/Google/);
    // It is not the sign in fact wearing another label.
    expect(ROSTER_NEEDS_PHOTO_TEXT).not.toMatch(/sign/i);
  });
});
