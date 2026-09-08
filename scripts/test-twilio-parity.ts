// Run: node --experimental-strip-types scripts/test-twilio-parity.ts
//
// WHY IT EXISTS. Slate reads each agent's debt tiers and backend service from
// Salesforce booleans. cal.com is fed the same facts from Twilio TaskRouter team
// tags by a Pipedream job. Nothing reconciles the two, so every agreement the
// cal.com comparison reports rests on somebody keeping Salesforce and Twilio in
// step (#2096). `Redistribute` is the sharp case: it exists ONLY as a Twilio tag,
// so it is the one routing input Slate has no way to see today.
import {
  readWorker,
  mergeWorkers,
  compareOne,
  TWILIO_VERDICT_RANK,
  IRRELEVANT_TAGS,
  MANAGER_TAG_PREFIX,
  type SlateSide,
} from "./lib/twilio-roster.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const worker = (teams: string[], email = "someone@trypennie.com") =>
  JSON.stringify({ email, teams });

function slate(over: Partial<SlateSide> = {}): SlateSide {
  return {
    email: "someone@trypennie.com",
    debtTeams: ["low"],
    backendServices: ["achieve"],
    legalEligibleN: false,
    bookable: true,
    deactivated: false,
    ...over,
  };
}

// --- reading a worker -----------------------------------------------------------
{
  const w = readWorker(worker(["Low Debt: 20k - 30k", "Achieve"]))!;
  eq(w.debtTeams.join(","), "low", "a debt band tag maps to the tier Slate stores");
  eq(w.backendServices.join(","), "achieve", "and a servicer tag to the backend Slate stores");
  assert(!w.redistribute && !w.notLegalEligible, "with neither of the two standalone tags set");
}
{
  const w = readWorker(worker(["Redistribute", "Not Legal Eligible", "High Debt: 50k+"]))!;
  assert(w.redistribute, "the Redistribute tag is read");
  assert(w.notLegalEligible, "so is Not Legal Eligible");
  eq(w.debtTeams.join(","), "high", "and they do not leak into the tier list");
}
{
  // A tag nobody mapped is REPORTED. Dropping it is how a tier added in Twilio
  // becomes invisible to the check written to notice drift (L217).
  const w = readWorker(worker(["Low Debt: 20k - 30k", "Brand New Team"]))!;
  eq(w.unmappedTags.join(","), "Brand New Team", "an unknown tag is carried through, not swallowed");
  eq(w.debtTeams.join(","), "low", "and the tags around it are still read");
}
{
  eq(readWorker('{"teams":["Achieve"]}'), null, "a worker with no email cannot be matched and is refused");
  eq(readWorker("not json at all"), null, "an unreadable attributes blob is refused rather than read as empty");
  eq(readWorker(null), null, "so is a missing one");
}
{
  const w = readWorker(JSON.stringify({ email: "  MiXeD@TryPennie.com ", teams: [] }))!;
  eq(w.email, "mixed@trypennie.com", "addresses are trimmed and lowercased, since that is how both sides match");
}

// --- duplicates -----------------------------------------------------------------
{
  const a = readWorker(worker(["Low Debt: 20k - 30k"]))!;
  const b = readWorker(worker(["High Debt: 50k+", "Redistribute"]))!;
  const { merged, duplicates } = mergeWorkers([a, b]);
  eq(duplicates, 1, "a second worker for one address is counted");
  eq(merged.debtTeams.join(","), "high,low", "and their tags are unioned, which is what cal.com receives");
  assert(merged.redistribute, "a tag on either worker counts");
}

// --- the comparison -------------------------------------------------------------
{
  const w = readWorker(worker(["Low Debt: 20k - 30k", "Achieve"]));
  eq(compareOne(w, slate()).verdict, "agree", "the same facts on both sides is the healthy case");
}
{
  // The finding that matters today.
  const w = readWorker(worker(["Low Debt: 20k - 30k", "Achieve", "Redistribute"]));
  eq(
    compareOne(w, slate({ bookable: true })).verdict,
    "redistribute-still-bookable",
    "Twilio withholding somebody Slate still offers is the worst finding here",
  );
}
{
  // POSITIVE CONTROL for that verdict: it must not fire on the corrected state, or
  // it would report the fix as the fault and every run would be red (L1).
  const w = readWorker(worker(["Low Debt: 20k - 30k", "Achieve", "Redistribute"]));
  eq(
    compareOne(w, slate({ bookable: false })).verdict,
    "agree",
    "and once Slate has them not bookable, the two systems agree",
  );
}
{
  const w = readWorker(worker(["High Debt: 50k+", "Achieve"]));
  const r = compareOne(w, slate({ debtTeams: ["low"] }));
  eq(r.verdict, "debt-teams-differ", "a different set of debt tiers is a finding");
  assert(r.detail.includes("low") && r.detail.includes("high"), "and the detail names both sides");
}
{
  const w = readWorker(worker(["Low Debt: 20k - 30k", "Beyond"]));
  eq(compareOne(w, slate({ backendServices: ["achieve"] })).verdict, "backend-differs", "so is a different backend");
}
{
  const w = readWorker(worker(["Low Debt: 20k - 30k", "Achieve", "Not Legal Eligible"]));
  eq(compareOne(w, slate({ legalEligibleN: false })).verdict, "legal-differs", "so is legal eligibility");
}
{
  eq(
    compareOne(readWorker(worker(["Achieve"])), null).verdict,
    "absent-from-slate",
    "a Twilio worker Slate has never heard of cannot be reconciled",
  );
  eq(compareOne(null, slate()).verdict, "absent-from-twilio", "and a Slate agent with no worker feeds cal.com nothing");
  eq(compareOne(null, null).verdict, "agree", "neither side holding them is not a finding");
}
{
  // Departure is asked before everything, because a departed agent's Twilio tags
  // are not a disagreement about a person taking calls.
  const w = readWorker(worker(["Ultra High Debt: 100k+", "Redistribute"]));
  eq(
    compareOne(w, slate({ deactivated: true, bookable: false })).verdict,
    "departed",
    "somebody who has left Slate is skipped rather than reported",
  );
}
{
  // A configuration fault in Twilio must not bury a real difference about a person.
  const w = readWorker(worker(["High Debt: 50k+", "Achieve", "Brand New Team"]));
  eq(
    compareOne(w, slate({ debtTeams: ["low"] }), 1).verdict,
    "debt-teams-differ",
    "a row that is both duplicated and different is named by the difference",
  );
}
{
  const w = readWorker(worker(["Low Debt: 20k - 30k", "Achieve", "Brand New Team"]));
  eq(compareOne(w, slate(), 0).verdict, "unmapped-tag", "an unknown tag is still reported on an otherwise matching row");
  eq(compareOne(w, slate(), 2).verdict, "duplicate-worker", "and duplication outranks it, being the sharper fault");
}

// --- the ranking ----------------------------------------------------------------
{
  eq(TWILIO_VERDICT_RANK.departed, TWILIO_VERDICT_RANK.agree, "a departure ranks level with agreement, so it cannot name a run");
  assert(
    TWILIO_VERDICT_RANK["redistribute-still-bookable"] > TWILIO_VERDICT_RANK["debt-teams-differ"],
    "and the finding that misroutes a lead today outranks the ones that are latent",
  );
  const ranks = Object.values(TWILIO_VERDICT_RANK).filter((r) => r > 0);
  eq(new Set(ranks).size, ranks.length, "no two findings share a rank, so the worst row is unambiguous");
}

// --- tags that are real and none of Slate's business ----------------------------
// Measured live 2026-09-08: 107 of 146 addresses carried at least one tag outside
// the routing vocabulary, and every one was legitimate. Reporting them made the
// command red on three quarters of the roster for a reason nobody should fix, which
// is how a check stops being read by the second week (L36). The Pipedream job
// ignores every one of these too, so they are not part of what cal.com receives.
{
  for (const tag of IRRELEVANT_TAGS) {
    const w = readWorker(worker(["Low Debt: 20k - 30k", "Achieve", tag]))!;
    eq(w.unmappedTags.length, 0, `"${tag}" is known and not reported`);
    eq(compareOne(w, slate()).verdict, "agree", `and a row carrying "${tag}" still agrees`);
  }
}
{
  // Manager assignment, matched by PREFIX rather than by naming the seven managers,
  // because a list of names goes stale the first time somebody changes job (L362).
  // Slate takes manager of record from Salesforce, never from Twilio.
  for (const name of ["Mike Dugan", "Matthew Jamele", "Somebody Hired Tomorrow"]) {
    const w = readWorker(worker(["Low Debt: 20k - 30k", "Achieve", `${MANAGER_TAG_PREFIX}${name}`]))!;
    eq(w.unmappedTags.length, 0, `a "${MANAGER_TAG_PREFIX}" tag for ${name} is a manager assignment, not a routing fact`);
  }
}
{
  // THE POSITIVE CONTROL. Without it, treating every tag as irrelevant satisfies
  // every assertion above and a genuinely new debt tier added in Twilio becomes
  // invisible to the check written to notice exactly that (L1, L217).
  const w = readWorker(worker(["Low Debt: 20k - 30k", "Achieve", "Mega Debt: 500k+"]))!;
  eq(w.unmappedTags.join(","), "Mega Debt: 500k+", "a tag nobody has classified IS still reported");
  eq(compareOne(w, slate()).verdict, "unmapped-tag", "and it still names the row");
}

// --- workers who are not people we employ ---------------------------------------
// Live, 16 Twilio workers have no Slate row and not one is a person: twelve Regal AI
// agents (`agent_pennie-mgmt_N@regal.ai`), two Regal logins and two vendor accounts.
// Judged by the REASON (Slate's users are on our own domain) rather than by listing
// the sixteen, so a thirteenth AI agent needs no code change.
{
  const w = readWorker(worker(["Low Debt: 20k - 30k"], "agent_pennie-mgmt_1@regal.ai"));
  eq(
    compareOne(w, null).verdict,
    "not-our-worker",
    "a worker on somebody else's domain is not a missing Slate user",
  );
}
{
  // THE POSITIVE CONTROL for that one: a real colleague missing from Slate must
  // still page, since that is a person who would take no leads at cutover.
  const w = readWorker(worker(["Low Debt: 20k - 30k"], "newhire@trypennie.com"));
  eq(
    compareOne(w, null).verdict,
    "absent-from-slate",
    "and one of OUR addresses with no Slate row still pages",
  );
}
{
  assert(
    TWILIO_VERDICT_RANK["not-our-worker"] === TWILIO_VERDICT_RANK.agree,
    "an outside worker ranks level with agreement, so sixteen of them cannot name a run",
  );
  assert(
    TWILIO_VERDICT_RANK["absent-from-slate"] > TWILIO_VERDICT_RANK.agree,
    "while a missing colleague still outranks it",
  );
}

finish();
