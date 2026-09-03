// The one rule every search box in Slate reads a typed query by (#1791).
//
// Dan, 2026-09-03: "spaces should be counted in text matching. this should show
// me nothing. \"John \" should show me john kite and sullivan but not anybody
// with the last name johnson". Three search boxes were each trimming the
// trailing space away, so the one thing a trailing space can say was impossible
// to say in any of them.
//
// This file pins the rule AND pins that all three call sites go through it. The
// second half is the point: sharing a constant while each caller keeps its own
// copy of the logic is not consolidation (L370), and a rule that lives only in
// one module's docstring is a hope (L27). So each search box is driven here with
// the same query and required to answer the same way.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-search-query.ts
import { assert, eq, finish } from "./lib/harness.ts";
import { matchesSearchQuery, normalizeSearchQuery } from "@/lib/search-query";
import { filterRoster, EMPTY_ROSTER_FILTERS, type RosterRow } from "@/lib/admin/roster-filter";
import { rankReassignAgents, type ReassignAgent } from "@/lib/booking/reassign-agents";
import { matchesRosterQuery, type RosterEntry } from "@/lib/admin/bucket-member-picker";

// ---------------------------------------------------------------------------
// normalizeSearchQuery: the asymmetric trim
// ---------------------------------------------------------------------------
{
  eq(normalizeSearchQuery("john "), "john ", "a trailing space is kept, it is the filter");
  eq(normalizeSearchQuery(" john"), "john", "a leading space is dropped, it is a paste");
  eq(normalizeSearchQuery("  John  "), "john  ", "both at once: leading gone, trailing intact");
  eq(normalizeSearchQuery("JOHN"), "john", "lowercased, since every field is compared lowercased");
  eq(normalizeSearchQuery(""), "", "nothing typed is no search");
  eq(normalizeSearchQuery("   "), "", "whitespace alone is no search, not a search for a space");
  eq(normalizeSearchQuery("\t\n "), "", "any whitespace, not just the space character");
  // A tab inside the query is not whitespace-only, so it survives as typed.
  eq(normalizeSearchQuery("a\tb"), "a\tb", "whitespace inside the query is left alone");
}

// ---------------------------------------------------------------------------
// matchesSearchQuery: fields separately, never joined
// ---------------------------------------------------------------------------
{
  assert(matchesSearchQuery("", "anything", "at all"), "an empty needle matches everything");
  assert(matchesSearchQuery("kite", "John Kite", "jkite@x.com"), "matches on the name");
  assert(matchesSearchQuery("jkite", "John Kite", "jkite@x.com"), "matches on the email");
  assert(
    !matchesSearchQuery("kite jkite", "John Kite", "jkite@x.com"),
    "cannot match across the gap between two fields",
  );
  assert(!matchesSearchQuery("john ", "Andrew Johnson", "ajohnson@x.com"), "johnson is not john");
  assert(matchesSearchQuery("john ", "John Kite", "jkite@x.com"), "john kite is");
  // The needle arrives already normalised, so it is the FIELDS this lowercases.
  assert(matchesSearchQuery("zed", "ZED", "z@x.com"), "the fields are lowercased too");
  assert(matchesSearchQuery("z@x", "ZED", "Z@X.com"), "including the email field");
  assert(!matchesSearchQuery("ada", null, undefined), "a null field is not a match, and does not throw");
  assert(matchesSearchQuery("ada", null, "ada@x.com"), "a null field does not hide a later one");
}

// ---------------------------------------------------------------------------
// All three search boxes answer the same way. This is the consolidation guard:
// each of these was independently trimming both ends before #1791.
// ---------------------------------------------------------------------------
const rosterRow = (name: string, email: string): RosterRow => ({
  id: email,
  name,
  email,
  role: "agent",
  bookable: true,
  manager_id: null,
  deactivated_at: null,
  attributes: {},
  avatar_url: null,
});

const PEOPLE: [string, string][] = [
  ["John Kite", "jkite@x.com"],
  ["John Sullivan", "jsullivan@x.com"],
  ["Andrew Johnson", "ajohnson@x.com"],
];

/** The same population, in each surface's own shape. */
const asRoster = PEOPLE.map(([n, e]) => rosterRow(n, e));
const asReassign: ReassignAgent[] = PEOPLE.map(([n, e]) => ({ id: e, name: n, email: e, bookable: true }));
const asEntries: RosterEntry[] = PEOPLE.map(([n, e]) => ({
  id: e,
  name: n,
  email: e,
  section: "Agents",
}));

/** Which emails each surface offers for `q`, sorted so only the SET is compared. */
const boxes: Record<string, (q: string) => string[]> = {
  "roster search": (q) =>
    filterRoster(asRoster, { ...EMPTY_ROSTER_FILTERS, q }).map((u) => u.email).sort(),
  "reassign picker": (q) => rankReassignAgents(asReassign, q).map((a) => a.email).sort(),
  "bucket member picker": (q) =>
    asEntries.filter((e) => matchesRosterQuery(e, q)).map((e) => e.email).sort(),
};

const cases: [string, string[]][] = [
  ["john ", ["jkite@x.com", "jsullivan@x.com"]],
  ["john", ["ajohnson@x.com", "jkite@x.com", "jsullivan@x.com"]],
  ["john  ", []],
  ["kite jkite", []],
  [" john", ["ajohnson@x.com", "jkite@x.com", "jsullivan@x.com"]],
  ["   ", ["ajohnson@x.com", "jkite@x.com", "jsullivan@x.com"]],
  ["", ["ajohnson@x.com", "jkite@x.com", "jsullivan@x.com"]],
];

for (const [name, box] of Object.entries(boxes)) {
  for (const [q, expected] of cases) {
    eq(
      box(q).join(","),
      expected.join(","),
      `${name}: ${JSON.stringify(q)} offers ${expected.length} of 3`,
    );
  }
}

// A positive control on the table above. Every expectation in it must not be the
// same answer, or a box hard-wired to return the whole population would satisfy
// the lot (L1).
{
  const answers = new Set(cases.map(([, e]) => e.join(",")));
  assert(answers.size >= 3, "the cases really do discriminate between three different answers");
}

finish();
