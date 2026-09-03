// The pure half of the bucket members picker (#1760).
//
// The picker exists because /admin/buckets rendered the WHOLE roster as native
// checkboxes inside EVERY bucket form: 9,450 `<input>` elements measured from the
// served page, roughly 14,000 at the 200 agent design target. The component half
// (on demand rendering, keyboard selection, posted form values) is a vitest suite;
// this file pins the logic that decides what a search matches and which section a
// person is listed under, because that is where a silent regression would hide
// (an empty section list and a filter that matches nothing render identically).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-bucket-member-picker.ts
import { assert, eq, finish } from "./lib/harness.ts";
import {
  ROSTER_SECTION_ORDER,
  matchesRosterQuery,
  rosterSectionFor,
  rosterSections,
  type RosterEntry,
} from "@/lib/admin/bucket-member-picker";
import { ROLES } from "@/lib/auth/roles";

const entry = (id: string, name: string, email: string, section: string): RosterEntry => ({
  id,
  name,
  email,
  section,
});

const AGENTS = "Agents";
const MANAGERS = "Managers";

// ---------------------------------------------------------------------------
// 1. Every role lands in a named section.
//
// A missing key would take a default branch, and a default is indistinguishable
// from a deliberate choice (L113). `rosterSectionFor` is a Record<Role, string>
// so tsc names an omission, and this asserts each one resolves to a section the
// renderer actually orders.
// ---------------------------------------------------------------------------
for (const role of ROLES) {
  const section = rosterSectionFor(role);
  assert(
    ROSTER_SECTION_ORDER.includes(section),
    `role ${role} maps to an ordered section (${section})`,
  );
}
assert(
  ROSTER_SECTION_ORDER[0] === AGENTS,
  "agents are the first section, because they are who a routing pool is for",
);

// ---------------------------------------------------------------------------
// 2. The search matches a name or an email, case insensitively, and never
//    matches everything when it is given a query.
// ---------------------------------------------------------------------------
{
  const ada = entry("a", "Ada Lovelace", "ada@trypennie.com", AGENTS);
  assert(matchesRosterQuery(ada, "ada"), "matches a lowercase name fragment");
  assert(matchesRosterQuery(ada, "LOVE"), "matches a name fragment case insensitively");
  assert(matchesRosterQuery(ada, "trypennie"), "matches an email fragment");
  assert(!matchesRosterQuery(ada, "hopper"), "does not match an unrelated fragment");
  assert(matchesRosterQuery(ada, "   "), "a whitespace-only query is treated as no query");
}

// ---------------------------------------------------------------------------
// 3. Sections come back in the declared order, alphabetical inside, and a
//    section with no matches is DROPPED rather than rendered empty.
//
// This is what makes the on demand list cheap: with a query, only matching rows
// exist at all, so the control count stops scaling with the roster.
// ---------------------------------------------------------------------------
{
  const roster: RosterEntry[] = [
    entry("m", "Grace Hopper", "grace@trypennie.com", MANAGERS),
    entry("a", "Ada Lovelace", "ada@trypennie.com", AGENTS),
    entry("t", "Alan Turing", "alan@trypennie.com", AGENTS),
  ];

  const all = rosterSections(roster, "");
  eq(all.map((s) => s.section).join(","), `${AGENTS},${MANAGERS}`, "sections in declared order");
  eq(
    all[0]!.entries.map((e) => e.name).join(","),
    "Ada Lovelace,Alan Turing",
    "entries sorted by name inside a section",
  );

  const narrowed = rosterSections(roster, "hopper");
  eq(narrowed.length, 1, "a query drops every section with no match");
  eq(narrowed[0]!.section, MANAGERS, "the surviving section is the one that matched");
  eq(narrowed[0]!.entries.length, 1, "only the matching row survives");

  eq(rosterSections(roster, "nobody-by-this-name").length, 0, "no matches means no sections");
  eq(
    rosterSections([], "").length,
    0,
    "an empty roster produces no sections rather than one empty section",
  );
}

// ---------------------------------------------------------------------------
// 4. A person with no name is still findable and still sorts.
//
// `users.name` is nullable, and the old checkbox list fell back to the email.
// Sorting a null into the list must not throw or bury the row.
// ---------------------------------------------------------------------------
{
  const nameless = entry("n", "", "zed@trypennie.com", AGENTS);
  assert(matchesRosterQuery(nameless, "zed"), "a nameless person is findable by email");
  const sections = rosterSections([nameless, entry("a", "Ada", "ada@x.com", AGENTS)], "");
  eq(sections[0]!.entries.length, 2, "a nameless person is still listed");
}

finish();
