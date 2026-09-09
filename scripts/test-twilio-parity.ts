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
  workerSideOrNull,
  mergeWorkers,
  compareOne,
  twilioLegalEligible,
  TWILIO_VERDICT_RANK,
  IRRELEVANT_TAGS,
  MANAGER_TAG_PREFIX,
  MANAGER_TAG_PREFIX as PREFIX,
  LEGAL_ELIGIBLE_YES,
  LEGAL_ELIGIBLE_NO,
  type SlateSide,
} from "@/lib/twilio/roster";
import { assert, eq, finish } from "./lib/harness.ts";

// Carries the manager tag by DEFAULT, so a case about debt tiers is not also a
// case about manager assignment. The manager cases below pass their own teams.
const worker = (teams: string[], email = "someone@trypennie.com") =>
  JSON.stringify({ email, teams: [...teams, `${PREFIX}Mike Dugan`] });

/** A worker with exactly the tags given, for the cases that are about the absence. */
const bareWorker = (teams: string[], email = "someone@trypennie.com") =>
  JSON.stringify({ email, teams });

/** The read's side, for the cases that are about the mapping rather than the faults. */
const side = (attributesJson: string) => workerSideOrNull(readWorker(attributesJson));

function slate(over: Partial<SlateSide> = {}): SlateSide {
  return {
    email: "someone@trypennie.com",
    debtTeams: ["low"],
    backendServices: ["achieve"],
    legalEligible: LEGAL_ELIGIBLE_NO,
    managerName: "Mike Dugan",
    bookable: true,
    deactivated: false,
    ...over,
  };
}

// --- reading a worker -----------------------------------------------------------
{
  const w = side(worker(["Low Debt: 20k - 30k", "Achieve"]))!;
  eq(w.debtTeams.join(","), "low", "a debt band tag maps to the tier Slate stores");
  eq(w.backendServices.join(","), "achieve", "and a servicer tag to the backend Slate stores");
  assert(!w.redistribute && !w.notLegalEligible, "with neither of the two standalone tags set");
}
{
  const w = side(worker(["Redistribute", "Not Legal Eligible", "High Debt: 50k+"]))!;
  assert(w.redistribute, "the Redistribute tag is read");
  assert(w.notLegalEligible, "so is Not Legal Eligible");
  eq(w.debtTeams.join(","), "high", "and they do not leak into the tier list");
}
{
  // A tag nobody mapped is REPORTED. Dropping it is how a tier added in Twilio
  // becomes invisible to the check written to notice drift (L217).
  const w = side(worker(["Low Debt: 20k - 30k", "Brand New Team"]))!;
  eq(w.unmappedTags.join(","), "Brand New Team", "an unknown tag is carried through, not swallowed");
  eq(w.debtTeams.join(","), "low", "and the tags around it are still read");
}
{
  // The two faults are told apart, because a corrupt blob is a Twilio data problem
  // somebody should look at and a worker with no email is ordinary (L11).
  const noEmail = readWorker('{"teams":["Achieve"]}');
  assert(!noEmail.ok && noEmail.why === "no-email", "valid JSON with no email is refused as no-email");
  const corrupt = readWorker("not json at all");
  assert(!corrupt.ok && corrupt.why === "unreadable-attributes", "and an unparseable blob is its own reason");
  const missing = readWorker(null);
  assert(!missing.ok && missing.why === "no-email", "a missing blob reads as an empty object, so no-email");
  assert(
    (corrupt as { why: string }).why !== (noEmail as { why: string }).why,
    "and the two never share a reason, or one message would answer for both",
  );
}
{
  const w = side(JSON.stringify({ email: "  MiXeD@TryPennie.com ", teams: [] }))!;
  eq(w.email, "mixed@trypennie.com", "addresses are trimmed and lowercased, since that is how both sides match");
}

// --- duplicates -----------------------------------------------------------------
{
  const a = side(worker(["Low Debt: 20k - 30k"]))!;
  const b = side(worker(["High Debt: 50k+", "Redistribute"]))!;
  const { merged, duplicates } = mergeWorkers([a, b]);
  eq(duplicates, 1, "a second worker for one address is counted");
  eq(merged.debtTeams.join(","), "high,low", "and their tags are unioned, which is what cal.com receives");
  assert(merged.redistribute, "a tag on either worker counts");
}

// --- the comparison -------------------------------------------------------------
{
  const w = side(worker(["Low Debt: 20k - 30k", "Achieve"]));
  eq(compareOne(w, slate()).verdict, "agree", "the same facts on both sides is the healthy case");
}
{
  // The finding that matters today.
  const w = side(worker(["Low Debt: 20k - 30k", "Achieve", "Redistribute"]));
  eq(
    compareOne(w, slate({ bookable: true })).verdict,
    "redistribute-still-bookable",
    "Twilio withholding somebody Slate still offers is the worst finding here",
  );
}
{
  // POSITIVE CONTROL for that verdict: it must not fire on the corrected state, or
  // it would report the fix as the fault and every run would be red (L1).
  const w = side(worker(["Low Debt: 20k - 30k", "Achieve", "Redistribute"]));
  eq(
    compareOne(w, slate({ bookable: false })).verdict,
    "agree",
    "and once Slate has them not bookable, the two systems agree",
  );
}
{
  const w = side(worker(["High Debt: 50k+", "Achieve"]));
  const r = compareOne(w, slate({ debtTeams: ["low"] }));
  eq(r.verdict, "debt-teams-differ", "a different set of debt tiers is a finding");
  assert(r.detail.includes("low") && r.detail.includes("high"), "and the detail names both sides");
}
{
  const w = side(worker(["Low Debt: 20k - 30k", "Beyond"]));
  eq(compareOne(w, slate({ backendServices: ["achieve"] })).verdict, "backend-differs", "so is a different backend");
}
{
  const w = side(worker(["Low Debt: 20k - 30k", "Achieve", "Legal Eligible"]));
  eq(
    compareOne(w, slate({ legalEligible: LEGAL_ELIGIBLE_NO })).verdict,
    "legal-differs",
    "so is legal eligibility, when Twilio calls somebody out and Slate has not",
  );
}
{
  eq(
    compareOne(side(worker(["Achieve"])), null).verdict,
    "absent-from-slate",
    "a Twilio worker Slate has never heard of cannot be reconciled",
  );
  eq(compareOne(null, slate()).verdict, "absent-from-twilio", "and a Slate agent with no worker feeds cal.com nothing");
  eq(compareOne(null, null).verdict, "agree", "neither side holding them is not a finding");
}
{
  // Departure is asked before everything, because a departed agent's Twilio tags
  // are not a disagreement about a person taking calls.
  const w = side(worker(["Ultra High Debt: 100k+", "Redistribute"]));
  eq(
    compareOne(w, slate({ deactivated: true, bookable: false })).verdict,
    "departed",
    "somebody who has left Slate is skipped rather than reported",
  );
}
{
  // A configuration fault in Twilio must not bury a real difference about a person.
  const w = side(worker(["High Debt: 50k+", "Achieve", "Brand New Team"]));
  eq(
    compareOne(w, slate({ debtTeams: ["low"] }), { duplicates: 1 }).verdict,
    "debt-teams-differ",
    "a row that is both duplicated and different is named by the difference",
  );
}
{
  const w = side(worker(["Low Debt: 20k - 30k", "Achieve", "Brand New Team"]));
  eq(compareOne(w, slate()).verdict, "unmapped-tag", "an unknown tag is still reported on an otherwise matching row");
  eq(compareOne(w, slate(), { duplicates: 2 }).verdict, "duplicate-worker", "and duplication outranks it, being the sharper fault");
}

// --- legal eligibility, which Twilio owns (#2098) --------------------------------
// Dan, 2026-09-09: "The default is N. Y is the only one called out." So the tag that
// decides this is the POSITIVE one, and every other state, including the explicit
// negative tag and a worker carrying neither, means excluded. That is the opposite
// reading from the one the negated bucket criteria suggest, and it is the reason
// this vocabulary is derived in one place rather than at each call site.
{
  const yes = side(worker(["Low Debt: 20k - 30k", "Legal Eligible"]))!;
  eq(twilioLegalEligible(yes), LEGAL_ELIGIBLE_YES, "the positive tag is the only thing that makes somebody eligible");
  assert(yes.legalEligible, "and the side carries it as its own fact");

  const silent = side(worker(["Low Debt: 20k - 30k"]))!;
  eq(twilioLegalEligible(silent), LEGAL_ELIGIBLE_NO, "a worker Twilio says nothing about is excluded, because the default is N");

  const explicitNo = side(worker(["Low Debt: 20k - 30k", "Not Legal Eligible"]))!;
  eq(twilioLegalEligible(explicitNo), LEGAL_ELIGIBLE_NO, "and so is one carrying the explicit negative tag");
  assert(explicitNo.notLegalEligible, "which is still read as its own fact, so the two tags can be told apart");
}
{
  // Neither tag is reported as unknown, or the roster sync would log two of its own
  // vocabulary every hour.
  const w = side(worker(["Low Debt: 20k - 30k", "Achieve", "Legal Eligible", "Not Legal Eligible"]))!;
  eq(w.unmappedTags.length, 0, "both legal tags are part of the vocabulary, not unmapped");
  eq(
    twilioLegalEligible(w),
    LEGAL_ELIGIBLE_NO,
    "a worker carrying BOTH tags is excluded: the contradiction resolves the safe way, since offering legal work to somebody nobody has cleared is the harm",
  );
  eq(
    compareOne(w, slate({ legalEligible: LEGAL_ELIGIBLE_NO })).verdict,
    "legal-tags-contradict",
    "and the contradiction is reported rather than quietly resolved (L340)",
  );
}
{
  const both = side(worker(["Legal Eligible", "Not Legal Eligible"]))!;
  const clean = side(worker(["Legal Eligible"]))!;
  const { merged } = mergeWorkers([clean, side(worker(["Low Debt: 20k - 30k"]))!]);
  assert(merged.legalEligible, "a positive tag on either duplicate worker counts, as every other tag does");
  assert(both.legalEligible && both.notLegalEligible, "and a contradicting worker carries both, rather than one erasing the other");
}
{
  // A value Slate has never been given is NOT the same as a measured N, and the
  // detail has to say which, because "not set" and "excluded" send a reader to two
  // different places (L11).
  const w = side(worker(["Low Debt: 20k - 30k", "Achieve"]));
  const r = compareOne(w, slate({ legalEligible: null }));
  eq(r.verdict, "legal-differs", "an unset Slate value is a difference from Twilio's measured N");
  assert(r.detail.includes("not set"), "and the detail names it as not set rather than calling it excluded");
}
{
  // THE POSITIVE CONTROL for the whole vocabulary: once Slate holds what Twilio
  // says, in both directions, the comparison is quiet. Without this, a rule that
  // reported everybody would satisfy every assertion above (L1).
  const yes = side(worker(["Low Debt: 20k - 30k", "Achieve", "Legal Eligible"]));
  eq(compareOne(yes, slate({ legalEligible: LEGAL_ELIGIBLE_YES })).verdict, "agree", "Y on both sides agrees");
  const no = side(worker(["Low Debt: 20k - 30k", "Achieve"]));
  eq(compareOne(no, slate({ legalEligible: LEGAL_ELIGIBLE_NO })).verdict, "agree", "and N on both sides agrees");
}
{
  // Ranked BELOW the differences about a person, like the other Twilio
  // configuration faults, so a contradicting worker cannot bury a real difference.
  const w = side(worker(["High Debt: 50k+", "Achieve", "Legal Eligible", "Not Legal Eligible"]));
  eq(
    compareOne(w, slate({ debtTeams: ["low"], legalEligible: LEGAL_ELIGIBLE_NO })).verdict,
    "debt-teams-differ",
    "a row that both contradicts itself and differs is named by the difference",
  );
}

// --- manager of record (#2099) ---------------------------------------------------
// Twilio carries manager assignment as a `Team <Manager Name>` tag, and Slate takes
// it from Salesforce's `Agent_Manager__c`. Nothing compared them, and a disagreement
// sends a time off request to somebody who is not that person's manager any more.
//
// This does NOT switch the source. Salesforce stays the recorded owner and the OOO
// approver chain is built on it; the point is to notice a divergence.
const KNOWN = new Set(["mike dugan", "brad lawrence", "rachel villar"]);

{
  const w = side(bareWorker(["Low Debt: 20k - 30k", "Achieve", `${PREFIX}Mike Dugan`]))!;
  eq(w.managerTags, ["Mike Dugan"], "the tag is read as a name, with the prefix stripped");
  eq(w.unmappedTags.length, 0, "and is not reported as a tag nobody knows");
  eq(
    compareOne(w, slate({ managerName: "Mike Dugan" }), { managerNames: KNOWN }).verdict,
    "agree",
    "the same manager on both sides is the healthy case",
  );
}
{
  const w = side(bareWorker(["Low Debt: 20k - 30k", "Achieve", `${PREFIX}Brad Lawrence`]));
  const r = compareOne(w, slate({ managerName: "Mike Dugan" }), { managerNames: KNOWN });
  eq(r.verdict, "manager-differs", "two systems naming different managers is a finding");
  assert(r.detail.includes("Mike Dugan") && r.detail.includes("Brad Lawrence"), "and the detail names both, since either one could be the wrong side");
}
{
  // Case and padding are how a person types a name, not a disagreement about one.
  const w = side(bareWorker(["Low Debt: 20k - 30k", "Achieve", `${PREFIX}  mike DUGAN `]));
  eq(
    compareOne(w, slate({ managerName: "Mike Dugan" }), { managerNames: KNOWN }).verdict,
    "agree",
    "names match on case and surrounding space, as addresses do everywhere else here",
  );
}
{
  const w = side(bareWorker(["Low Debt: 20k - 30k", "Achieve", `${PREFIX}Somebody Nobody Hired`]));
  const r = compareOne(w, slate({ managerName: "Mike Dugan" }), { managerNames: KNOWN });
  eq(r.verdict, "manager-not-in-slate", "a tag naming somebody Slate has no user for is its own finding, not just a difference");
  assert(r.detail.includes("Somebody Nobody Hired"), "and says the name, since that is the whole of what has to be looked up");
}
{
  const w = side(bareWorker(["Low Debt: 20k - 30k", "Achieve", `${PREFIX}Mike Dugan`]));
  const r = compareOne(w, slate({ managerName: null }), { managerNames: KNOWN });
  eq(r.verdict, "manager-absent-from-slate", "Twilio naming a manager Slate has not linked is its own finding");
  assert(r.detail.includes("Mike Dugan"), "naming who Twilio thinks it is");
}
{
  const w = side(bareWorker(["Low Debt: 20k - 30k", "Achieve"]));
  const r = compareOne(w, slate({ managerName: "Brad Lawrence" }), { managerNames: KNOWN });
  eq(r.verdict, "manager-absent-from-twilio", "and a worker with no team tag at all, for somebody Slate has a manager for, is the mirror finding");
}
{
  // THE CONTROL that keeps this quiet on the twenty workers who legitimately carry
  // no team tag. Sixteen are managers and admins with no manager of their own, and
  // four are agents Slate has no manager for either. Without this, the check would
  // report a fifth of the roster on the day it shipped and stop being read (L36).
  const w = side(bareWorker(["Low Debt: 20k - 30k", "Achieve"]));
  eq(
    compareOne(w, slate({ managerName: null }), { managerNames: KNOWN }).verdict,
    "agree",
    "neither side naming a manager is agreement, not a finding",
  );
}
{
  const w = side(bareWorker([`${PREFIX}Mike Dugan`, `${PREFIX}Brad Lawrence`, "Low Debt: 20k - 30k", "Achieve"]))!;
  eq(w.managerTags, ["Brad Lawrence", "Mike Dugan"], "both tags are kept, sorted, rather than one silently winning");
  eq(
    compareOne(w, slate({ managerName: "Mike Dugan" }), { managerNames: KNOWN }).verdict,
    "manager-tags-contradict",
    "a worker carrying two team tags is reported, even when one of them agrees, because picking the agreeing one hides the fault (L340)",
  );
}
{
  // Ranked BELOW every difference about what somebody can be routed for: a wrong
  // approver is worth knowing and does not misroute a lead.
  const w = side(bareWorker(["High Debt: 50k+", "Achieve", `${PREFIX}Brad Lawrence`]));
  eq(
    compareOne(w, slate({ debtTeams: ["low"], managerName: "Mike Dugan" }), { managerNames: KNOWN }).verdict,
    "debt-teams-differ",
    "a row that differs on both is named by the routing difference",
  );
}
{
  // And ABOVE the Twilio configuration faults, because it is a disagreement about a
  // person rather than a fault in how a worker is set up.
  const w = side(bareWorker(["Low Debt: 20k - 30k", "Achieve", `${PREFIX}Brad Lawrence`, "Brand New Team"]));
  eq(
    compareOne(w, slate({ managerName: "Mike Dugan" }), { duplicates: 1, managerNames: KNOWN }).verdict,
    "manager-differs",
    "a duplicated worker does not bury a manager disagreement",
  );
}
{
  // With no roster to check against, the comparison must not INVENT the stronger
  // finding: an unknown name is only unknown once somebody has looked.
  const w = side(bareWorker(["Low Debt: 20k - 30k", "Achieve", `${PREFIX}Somebody Nobody Hired`]));
  eq(
    compareOne(w, slate({ managerName: "Mike Dugan" })).verdict,
    "manager-differs",
    "without a list of Slate names, an unrecognised tag is reported as a difference rather than as a missing user",
  );
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
    const w = side(worker(["Low Debt: 20k - 30k", "Achieve", tag]))!;
    eq(w.unmappedTags.length, 0, `"${tag}" is known and not reported`);
    eq(compareOne(w, slate()).verdict, "agree", `and a row carrying "${tag}" still agrees`);
  }
}
{
  // The four the FIRST LIVE RUN of the roster sync reported (#2116). Each was
  // unclassified, so each was written to the log every hour and could name a
  // `pnpm verify:twilio-parity` run as `unmapped-tag` for somebody who agreed on
  // everything else, which is how a real signal turns into noise and a check stops
  // being read (L36, L217).
  //
  // Named here rather than left to the loop above, which iterates whatever the list
  // happens to hold and so cannot fail before they are in it (L1).
  for (const tag of ["AI Agent", "New Recruit", "Red", "Short Links"]) {
    const w = side(worker(["Low Debt: 20k - 30k", "Achieve", tag]))!;
    eq(w.unmappedTags.length, 0, `"${tag}" was measured on the live roster and is classified`);
    eq(compareOne(w, slate()).verdict, "agree", `and a row carrying "${tag}" agrees rather than reporting it`);
  }
}
{
  // The one that is only true of the real data: Twilio stores it as `"New Recruit "`
  // with a trailing space. `readWorker` trims every tag before matching, so the
  // classification holds, and this pins that it does rather than leaving the live
  // roster to find out.
  const w = side(worker(["Low Debt: 20k - 30k", " New Recruit "]))!;
  eq(w.unmappedTags.length, 0, "a classified tag padded with spaces, as Twilio actually stores it, still matches");
}
{
  // Manager assignment, matched by PREFIX rather than by naming the seven managers,
  // because a list of names goes stale the first time somebody changes job (L362).
  // Slate takes manager of record from Salesforce, never from Twilio.
  for (const name of ["Mike Dugan", "Matthew Jamele", "Somebody Hired Tomorrow"]) {
    const w = side(worker(["Low Debt: 20k - 30k", "Achieve", `${MANAGER_TAG_PREFIX}${name}`]))!;
    eq(w.unmappedTags.length, 0, `a "${MANAGER_TAG_PREFIX}" tag for ${name} is a manager assignment, not a routing fact`);
  }
}
{
  // THE POSITIVE CONTROL. Without it, treating every tag as irrelevant satisfies
  // every assertion above and a genuinely new debt tier added in Twilio becomes
  // invisible to the check written to notice exactly that (L1, L217).
  const w = side(worker(["Low Debt: 20k - 30k", "Achieve", "Mega Debt: 500k+"]))!;
  eq(w.unmappedTags.join(","), "Mega Debt: 500k+", "a tag nobody has classified IS still reported");
  eq(compareOne(w, slate()).verdict, "unmapped-tag", "and it still names the row");
}

// --- workers who are not people we employ ---------------------------------------
// Live, 16 Twilio workers have no Slate row and not one is a person: twelve Regal AI
// agents (`agent_pennie-mgmt_N@regal.ai`), two Regal logins and two vendor accounts.
// Judged by the REASON (Slate's users are on our own domain) rather than by listing
// the sixteen, so a thirteenth AI agent needs no code change.
{
  const w = side(worker(["Low Debt: 20k - 30k"], "agent_pennie-mgmt_1@regal.ai"));
  eq(
    compareOne(w, null).verdict,
    "not-our-worker",
    "a worker on somebody else's domain is not a missing Slate user",
  );
}
{
  // THE POSITIVE CONTROL for that one: a real colleague missing from Slate must
  // still page, since that is a person who would take no leads at cutover.
  const w = side(worker(["Low Debt: 20k - 30k"], "newhire@trypennie.com"));
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
