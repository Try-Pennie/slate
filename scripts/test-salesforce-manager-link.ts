// The manager-of-record name lookup (#1653). Pure, so every branch is reachable
// with no Salesforce and no database.
//
// What is being pinned: a picklist name that answers to MORE than one Salesforce
// user is a refusal in its own right (L521), it is never the same outcome as a
// name that answers to nobody (L11), and an ambiguous name is never handed to the
// looser fallback matcher to be guessed at (L75).
//
// Run: node --experimental-strip-types scripts/test-salesforce-manager-link.ts
import {
  exactNameMatch,
  initialLastNameMatch,
  mergeManagerNamePlans,
  planManagerNames,
  splitUnresolvedByAmbiguity,
  type SfManagerCandidate,
} from "../src/lib/salesforce/manager-link.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const cand = (
  over: Partial<SfManagerCandidate> & { email: string },
): SfManagerCandidate => ({
  name: "",
  firstName: "",
  lastName: "",
  salesforceRecordId: null,
  ...over,
});

const person = (
  id: string,
  first: string,
  last: string,
  email: string,
): SfManagerCandidate =>
  cand({
    name: `${first} ${last}`,
    firstName: first,
    lastName: last,
    email,
    salesforceRecordId: id,
  });

// --- exactly one match links -------------------------------------------------
{
  const plan = planManagerNames(
    ["Jason Campbell"],
    [person("005a", "Jason", "Campbell", "jcampbell@trypennie.com")],
    exactNameMatch,
  );
  eq(
    plan.resolved.get("Jason Campbell"),
    "jcampbell@trypennie.com",
    "one match links to that person's email",
  );
  eq(plan.ambiguous.length, 0, "one match is not ambiguous");
  eq(plan.unmatched.length, 0, "one match is not unmatched");
}

// --- MANY matches refuse, and are reported as ambiguity (L521) ---------------
{
  const plan = planManagerNames(
    ["Andrew Romagnoli"],
    [
      person("005a", "Andrew", "Romagnoli", "aromagnoli@trypennie.com"),
      person("005b", "Andrew", "Romagnoli", "andrew.romagnoli@trypennie.com"),
    ],
    exactNameMatch,
  );
  assert(
    !plan.resolved.has("Andrew Romagnoli"),
    "two Salesforce users answering to one name links NOTHING",
  );
  eq(plan.ambiguous.length, 1, "the ambiguity is reported, not discarded");
  eq(plan.ambiguous[0].name, "Andrew Romagnoli", "the report names the picklist value");
  eq(plan.ambiguous[0].matchCount, 2, "the report says how many answered to it");
  eq(
    plan.unmatched.length,
    0,
    "many matches is never also reported as absence (they are different things to go and do)",
  );
}

// Three, so the count is a real count and not a hard-coded 2.
{
  const plan = planManagerNames(
    ["Enrique Valdez"],
    [
      person("005a", "Enrique", "Valdez", "e1@x.com"),
      person("005b", "Enrique", "Valdez", "e2@x.com"),
      person("005c", "Enrique", "Valdez", "e3@x.com"),
    ],
    exactNameMatch,
  );
  eq(plan.ambiguous[0]?.matchCount, 3, "three matches are counted as three");
}

// --- ZERO matches refuse with a DIFFERENT outcome ----------------------------
{
  const plan = planManagerNames(
    ["Nobody Matching"],
    [person("005a", "Jason", "Campbell", "jcampbell@trypennie.com")],
    exactNameMatch,
  );
  assert(!plan.resolved.has("Nobody Matching"), "no match links nothing");
  eq(plan.unmatched, ["Nobody Matching"], "absence is reported as absence");
  eq(plan.ambiguous.length, 0, "absence is never reported as ambiguity");
}

// --- the same Salesforce record arriving twice is ONE person -----------------
//
// The candidate pool is assembled from more than one query and `queryAll`
// paginates, so a repeated record must not read as two people sharing a name:
// that would refuse every ordinary manager in the org.
{
  const dup = person("005a", "Jason", "Campbell", "jcampbell@trypennie.com");
  const plan = planManagerNames(
    ["Jason Campbell"],
    [dup, { ...dup }],
    exactNameMatch,
  );
  eq(
    plan.resolved.get("Jason Campbell"),
    "jcampbell@trypennie.com",
    "one record seen twice still links",
  );
  eq(plan.ambiguous.length, 0, "a repeated response is not a collision");
}

// Two records that carry no Id are told apart by name plus email, so a genuine
// pair is still caught when the query did not ask for the Id.
{
  const plan = planManagerNames(
    ["Jason Campbell"],
    [
      cand({ name: "Jason Campbell", email: "j1@x.com" }),
      cand({ name: "Jason Campbell", email: "j2@x.com" }),
    ],
    exactNameMatch,
  );
  eq(plan.ambiguous.length, 1, "two id-less records with different emails are two people");
}

// --- candidates that cannot be a link target are not matches at all ---------
{
  const plan = planManagerNames(
    ["Jason Campbell"],
    [
      cand({ name: "Jason Campbell", email: "", salesforceRecordId: "005a" }),
      person("005b", "Jason", "Campbell", "jcampbell@trypennie.com"),
    ],
    exactNameMatch,
  );
  eq(
    plan.resolved.get("Jason Campbell"),
    "jcampbell@trypennie.com",
    "a candidate with no email is not a match, so it cannot manufacture ambiguity",
  );
}

// Matching is case and whitespace insensitive on the name, and the email is
// normalized, because both arrive as somebody's typing.
{
  const plan = planManagerNames(
    ["  jason campbell "],
    [person("005a", "Jason", "Campbell", "JCampbell@TryPennie.com")],
    exactNameMatch,
  );
  eq(
    plan.resolved.get("  jason campbell "),
    "jcampbell@trypennie.com",
    "the name is matched loosely on case and space, the email comes back lowercased",
  );
}

// --- the fallback matcher: informal picklist names ---------------------------
//
// Moved here from test-salesforce-manager-sync.ts with matchByInitialLastName,
// so there is ONE implementation of the rule rather than two.
{
  const cands = [
    person("005a", "Michael", "Dugan", "mdugan@x.com"),
    person("005b", "Matt", "Rasmussen", "mrasmussen@x.com"),
  ];
  const plan = planManagerNames(
    ["Mike Dugan", "Matthew Rasmussen", "Jane Doe", "Cher"],
    cands,
    initialLastNameMatch,
  );
  eq(
    plan.resolved.get("Mike Dugan"),
    "mdugan@x.com",
    "informal 'Mike Dugan' resolves to Michael Dugan by initial plus last name",
  );
  eq(
    plan.resolved.get("Matthew Rasmussen"),
    "mrasmussen@x.com",
    "'Matthew Rasmussen' resolves to Matt Rasmussen",
  );
  assert(plan.unmatched.includes("Jane Doe"), "no match is reported as absence");
  assert(
    plan.unmatched.includes("Cher"),
    "a single-token name can never be matched on initial plus last name",
  );
}

// Two people with the same initial and last name: never guess, and now say so.
{
  const plan = planManagerNames(
    ["Mike Dugan"],
    [
      person("005a", "Michael", "Dugan", "mdugan@x.com"),
      person("005c", "Mary", "Dugan", "marydugan@x.com"),
    ],
    initialLastNameMatch,
  );
  assert(!plan.resolved.has("Mike Dugan"), "Michael and Mary Dugan do NOT resolve");
  eq(
    plan.ambiguous.length,
    1,
    "the fallback's ambiguity is reported too, not swallowed as a plain miss",
  );
}

// --- merging the two passes --------------------------------------------------
//
// The load-bearing rule: only names the exact pass could not match AT ALL get a
// second, looser look. An ambiguous name is a refusal, and handing a refusal to a
// looser matcher is exactly the "aim at a nearby candidate" failure (L75).
{
  const exact = planManagerNames(
    ["Andrew Romagnoli", "Mike Dugan"],
    [
      person("005a", "Andrew", "Romagnoli", "a1@x.com"),
      person("005b", "Andrew", "Romagnoli", "a2@x.com"),
    ],
    exactNameMatch,
  );
  eq(exact.unmatched, ["Mike Dugan"], "the ambiguous name is NOT offered to the fallback");

  const loose = planManagerNames(
    exact.unmatched,
    [person("005c", "Michael", "Dugan", "mdugan@x.com")],
    initialLastNameMatch,
  );
  const merged = mergeManagerNamePlans(exact, loose);

  eq(
    merged.resolved.get("Mike Dugan"),
    "mdugan@x.com",
    "the fallback's win survives the merge",
  );
  eq(merged.ambiguous.length, 1, "the exact pass's ambiguity survives the merge");
  eq(merged.ambiguous[0].name, "Andrew Romagnoli", "and it is still the same name");
  eq(merged.unmatched.length, 0, "a name the fallback matched is no longer unmatched");
  assert(
    !merged.resolved.has("Andrew Romagnoli"),
    "the merge cannot resurrect an ambiguous name as a link",
  );
}

// The merge is asked directly to overturn an ambiguity, by handing it a second
// pass that DOES resolve the ambiguous name. It must refuse, because the merge is
// the last place a weaker match could quietly beat a stronger refusal, and a
// caller computing the second pass over the wrong set is exactly how that would
// arrive.
{
  const exact = planManagerNames(
    ["Andrew Romagnoli"],
    [
      person("005a", "Andrew", "Romagnoli", "a1@x.com"),
      person("005b", "Andrew", "Romagnoli", "a2@x.com"),
    ],
    exactNameMatch,
  );
  const loose = planManagerNames(
    ["Andrew Romagnoli"],
    [person("005c", "Andy", "Romagnoli", "a3@x.com")],
    initialLastNameMatch,
  );
  eq(
    loose.resolved.get("Andrew Romagnoli"),
    "a3@x.com",
    "the second pass really does have an answer, so the refusal below is a choice",
  );

  const merged = mergeManagerNamePlans(exact, loose);
  assert(
    !merged.resolved.has("Andrew Romagnoli"),
    "the merge refuses a second pass answer for a name the first pass called ambiguous",
  );
  eq(merged.ambiguous.length, 1, "and it is still reported as ambiguous");
}

// A name the fallback ALSO could not settle stays refused, in whichever way the
// later pass refused it.
{
  const exact = planManagerNames(["Mike Dugan"], [], exactNameMatch);
  const loose = planManagerNames(
    ["Mike Dugan"],
    [
      person("005a", "Michael", "Dugan", "mdugan@x.com"),
      person("005c", "Mary", "Dugan", "marydugan@x.com"),
    ],
    initialLastNameMatch,
  );
  const merged = mergeManagerNamePlans(exact, loose);
  eq(merged.ambiguous.length, 1, "the fallback's ambiguity is what the merge reports");
  eq(merged.unmatched.length, 0, "and it is not ALSO reported as absence");
}

{
  const exact = planManagerNames(["Ghost Person"], [], exactNameMatch);
  const loose = planManagerNames(["Ghost Person"], [], initialLastNameMatch);
  const merged = mergeManagerNamePlans(exact, loose);
  eq(merged.unmatched, ["Ghost Person"], "a name neither pass matched is reported absent");
  eq(merged.ambiguous.length, 0, "and never as ambiguity");
}

// --- splitting the per-agent report ------------------------------------------
//
// `resolveManagerSync` reports one entry per AGENT whose manager name did not
// resolve, and both refusals arrive there identically. The split is what lets the
// two be said differently, which is the whole point (L11).
{
  const split = splitUnresolvedByAmbiguity(
    ["Andrew Romagnoli", "Andrew Romagnoli", "Ghost Person"],
    ["Andrew Romagnoli"],
  );
  eq(split.ambiguous.length, 2, "both agents under the shared name are counted as ambiguous");
  eq(split.missing, ["Ghost Person"], "and the unmatched name is counted separately");
}

{
  const split = splitUnresolvedByAmbiguity([], []);
  eq(split.ambiguous.length, 0, "nothing unresolved reports no ambiguity");
  eq(split.missing.length, 0, "nothing unresolved reports no absence");
}

finish();
