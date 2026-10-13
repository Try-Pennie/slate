// The Slate half of the shared cross system rep key (#1587).
//
// Slate names a rep by EMAIL, and resolves their manager by matching a picklist
// NAME. Both are values a person can change, so the two downstream pieces of work
// that have to name a rep across systems (#307's time off feed and #329's manager
// drift check) are betting on a string nobody promised to keep stable. The remedy
// is `users.salesforce_user_id`, populated by the hourly roster sync.
//
// The rules this file pins are the ones a naive implementation gets wrong, and
// every one of them is a case where doing NOTHING is the correct behaviour, which
// is exactly the behaviour no test notices unless it asserts it:
//
//   - a DISAGREEMENT (Slate holds one id, Salesforce now names another) is
//     REPORTED, never rewritten. Overwriting would silently re-point every
//     consumer at a different human, and the write would look like a healthy sync.
//   - MANY matches store NO id (L521): a lookup that requires exactly one match
//     must treat many as its own refusal, never as absence. Storing the first of
//     two is a coin flip nobody would know had been tossed.
//   - an id already CLAIMED by another Slate row stores nothing. The database's
//     partial unique index would refuse the write anyway, and a refused write
//     throws the whole hourly sync; catching it here turns a roster outage into a
//     report about the one row that is wrong.
//   - an id is NEVER cleared. A roster row absent from one Salesforce response is
//     not evidence its Salesforce user is gone, so an existing key survives.
//   - a second run over the same data writes NOTHING (the sync is hourly, so it
//     runs twice by construction).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-salesforce-user-id-link.ts

import { assert, eq, finish } from "./lib/harness.ts";
import {
  planSalesforceUserIds,
  requireSalesforceUserId,
  USER_ID_CONFLICT_SHAPES,
  userIdConflictLogFields,
  type SfIdCandidate,
  type SlateRosterRow,
} from "../src/lib/salesforce/user-id-link.ts";

const ID_A = "005000000000001AAA";
const ID_B = "005000000000002AAA";
const ID_C = "005000000000003AAA";

function row(
  id: string,
  email: string,
  salesforceUserId: string | null = null,
): SlateRosterRow {
  return { id, email, salesforceUserId };
}
function cand(email: string, salesforceUserId: string): SfIdCandidate {
  return { email, salesforceUserId };
}

// --- the ordinary case: one match, no id held, so it is written --------------
{
  const plan = planSalesforceUserIds(
    [row("u1", "a@x.com"), row("u2", "b@x.com")],
    [cand("a@x.com", ID_A), cand("b@x.com", ID_B)],
  );
  eq(plan.assign.length, 2, "both unlinked rows are assigned their one match");
  eq(plan.assign[0].userId, "u1", "the first assignment names the Slate row");
  eq(plan.assign[0].salesforceUserId, ID_A, "and carries the Salesforce id");
  eq(plan.disagreements.length, 0, "nothing disagrees");
  eq(plan.ambiguous.length, 0, "nothing is ambiguous");
  eq(plan.claimed.length, 0, "nothing is claimed");
  eq(plan.unresolved.length, 0, "nothing is unresolved");
}

// --- matching is case insensitive on the email, like the rest of the sync -----
{
  const plan = planSalesforceUserIds(
    [row("u1", "Agent.A@X.com")],
    [cand("agent.a@x.com", ID_A)],
  );
  eq(plan.assign.length, 1, "an email matches regardless of case");
  eq(plan.assign[0].salesforceUserId, ID_A, "and resolves to the right id");
}

// --- idempotence: the same data twice writes nothing the second time ----------
//
// The sync runs hourly, so "assume it runs twice" is not a hypothetical. A plan
// that re-proposed every assignment would be a write storm that also re-races the
// unique index every hour.
{
  const roster = [row("u1", "a@x.com"), row("u2", "b@x.com")];
  const candidates = [cand("a@x.com", ID_A), cand("b@x.com", ID_B)];
  const first = planSalesforceUserIds(roster, candidates);
  eq(first.assign.length, 2, "the first pass assigns both");

  // Apply the first plan to the roster, exactly as the sync's write would.
  const applied = roster.map((r) => {
    const a = first.assign.find((x) => x.userId === r.id);
    return a ? { ...r, salesforceUserId: a.salesforceUserId } : r;
  });
  const second = planSalesforceUserIds(applied, candidates);
  eq(second.assign.length, 0, "the second pass over the same data writes NOTHING");
  eq(second.disagreements.length, 0, "and an id agreeing with itself is not a disagreement");
  eq(second.ambiguous.length, 0, "and nothing became ambiguous");
  eq(second.unresolved.length, 0, "and a row that already holds its id is not unresolved");
}

// --- a disagreement is REPORTED and does NOT overwrite ------------------------
{
  const plan = planSalesforceUserIds(
    [row("u1", "a@x.com", ID_A)],
    [cand("a@x.com", ID_B)],
  );
  eq(plan.assign.length, 0, "a disagreement writes NOTHING (never overwritten)");
  eq(plan.disagreements.length, 1, "the disagreement is reported");
  eq(plan.disagreements[0].userId, "u1", "and names the Slate row");
  eq(plan.disagreements[0].stored, ID_A, "and what Slate holds");
  eq(plan.disagreements[0].salesforce, ID_B, "and what Salesforce now says");
  eq(plan.unresolved.length, 0, "a disagreeing row is not also counted unresolved");
}

// --- MANY Salesforce users matching one Slate row store NO id (L521) ----------
//
// Real and not hypothetical: measured on 2026-08-31, two email addresses in the
// live Salesforce org are shared by more than one ACTIVE User record.
{
  const plan = planSalesforceUserIds(
    [row("u1", "shared@x.com")],
    [cand("shared@x.com", ID_A), cand("shared@x.com", ID_B)],
  );
  eq(plan.assign.length, 0, "two matches store NO id");
  eq(plan.ambiguous.length, 1, "and the refusal is reported");
  eq(plan.ambiguous[0].matchCount, 2, "with how many matched");
  eq(plan.unresolved.length, 0, "many matches is a refusal, never reported as absence");
  eq(plan.disagreements.length, 0, "and it is not dressed up as a disagreement either");
}

// The same Salesforce record arriving twice (it appears in two of the sync's
// queries) is ONE match, not an ambiguity. Deduplicating by id is what tells a
// duplicated response apart from two real people.
{
  const plan = planSalesforceUserIds(
    [row("u1", "a@x.com")],
    [cand("a@x.com", ID_A), cand("a@x.com", ID_A)],
  );
  eq(plan.ambiguous.length, 0, "the same id twice is one match, not an ambiguity");
  eq(plan.assign.length, 1, "so it is assigned normally");
}

// A row that already holds an id and then goes ambiguous keeps its id, and the
// ambiguity is still reported. Nothing here is grounds for clearing.
{
  const plan = planSalesforceUserIds(
    [row("u1", "shared@x.com", ID_A)],
    [cand("shared@x.com", ID_A), cand("shared@x.com", ID_B)],
  );
  eq(plan.assign.length, 0, "an ambiguous key writes nothing over an existing id");
  eq(plan.ambiguous.length, 1, "the ambiguity is still reported");
  eq(plan.disagreements.length, 0, "and is not reported as a disagreement (nothing can say which is right)");
}

// --- an id already held by ANOTHER Slate row is refused, not written ----------
//
// The database's partial unique index refuses this write, and a refused write
// throws the whole hourly roster sync. Catching it in the plan turns a roster
// outage into a report about the one row that is wrong.
{
  const plan = planSalesforceUserIds(
    [row("u1", "a@x.com", ID_A), row("u2", "b@x.com")],
    [cand("b@x.com", ID_A)],
  );
  eq(plan.assign.length, 0, "an id another row already holds is NOT written");
  eq(plan.claimed.length, 1, "the conflict is reported");
  eq(plan.claimed[0].userId, "u2", "naming the row that wanted it");
  eq(plan.claimed[0].heldBy, "u1", "and the row that holds it");
  eq(plan.unresolved.length, 0, "a refusal is never reported as absence");
}

// Two rows in the SAME pass wanting one id: one gets it, the other is reported.
// Without this the batch itself would carry two rows for one id and the partial
// unique index would refuse the whole write, taking the roster sync down with it.
{
  const plan = planSalesforceUserIds(
    [row("u1", "a@x.com"), row("u2", "alias@x.com")],
    [cand("a@x.com", ID_C), cand("alias@x.com", ID_C)],
  );
  eq(plan.assign.length, 1, "only one of two rows wanting one id is assigned");
  eq(plan.claimed.length, 1, "the other is reported, not written");
  eq(plan.claimed[0].heldBy, "u1", "naming the row that took it in this same pass");
}

// --- an unresolvable roster row is REPORTED, not silently skipped -------------
{
  const plan = planSalesforceUserIds(
    [row("u1", "a@x.com"), row("u2", "ghost@x.com")],
    [cand("a@x.com", ID_A)],
  );
  eq(plan.assign.length, 1, "the resolvable row is still assigned");
  eq(plan.unresolved.length, 1, "the unresolvable one is reported");
  eq(plan.unresolved[0].userId, "u2", "and named");
}

// --- an id is NEVER cleared --------------------------------------------------
//
// Absence from one Salesforce response is not evidence the Salesforce user is
// gone: this sync queries a slice of the org and knows nothing about the rest.
{
  const plan = planSalesforceUserIds([row("u1", "a@x.com", ID_A)], []);
  eq(plan.assign.length, 0, "an unmatched row that already holds an id writes nothing");
  eq(plan.unresolved.length, 0, "and is not reported as unresolved: it already has its key");
  eq(plan.disagreements.length, 0, "and absence is not a disagreement");
  assert(
    JSON.stringify(plan).includes(ID_A) === false,
    "no branch of the plan proposes touching an already-linked row's id",
  );
}

// --- a blank Salesforce id is not an id --------------------------------------
{
  const plan = planSalesforceUserIds([row("u1", "a@x.com")], [cand("a@x.com", "  ")]);
  eq(plan.assign.length, 0, "a blank id is never written");
  eq(plan.unresolved.length, 1, "and the row reads as unresolved");
}

// --- the consumer contract: a null id REFUSES, it never falls back (L75) ------
//
// There are no consumers yet, so this is the contract they will be built against
// rather than a description of one. The whole point of the key is that a name or
// an email change cannot silently re-point it at somebody else, and a fallback to
// either would hand that property straight back.
//
// The row is handed over WITH its email on purpose. The parameter type does not
// ask for one, so a caller has to go out of its way to supply it, and the point of
// the assertion below is that even a caller that does gets no email back out.
{
  const withEmail = { id: "u1", email: "a@x.com", salesforce_user_id: null };
  let threw = false;
  let message = "";
  try {
    requireSalesforceUserId(withEmail);
  } catch (err) {
    threw = true;
    message = err instanceof Error ? err.message : String(err);
  }
  assert(threw, "a null Salesforce id REFUSES rather than returning anything");
  assert(
    message.includes("u1"),
    "and the refusal names the row, so a reader can go and look at it",
  );
  assert(
    message.includes("a@x.com") === false,
    "and does NOT hand back the email, which is the fallback this contract exists to prevent",
  );
}
{
  let threw = false;
  try {
    const blank = { id: "u1", email: "a@x.com", salesforce_user_id: "   " };
    requireSalesforceUserId(blank);
  } catch {
    threw = true;
  }
  assert(threw, "a blank id refuses too (an empty string is not a key)");
}
{
  const linked = { id: "u1", email: "a@x.com", salesforce_user_id: ID_A };
  eq(requireSalesforceUserId(linked), ID_A, "a real id is returned unchanged");
}

// --- the conflict log line names the Slate rows of EVERY conflict shape (#3668) --
//
// The page tells the reader the sf-sync log line names the rows. For an ambiguous
// email it used to carry only a count, so the page's pointer led nowhere for that
// shape and finding the row took a hand query against Salesforce. Each shape is
// driven here and its rows must appear under its own field.
{
  const plan = planSalesforceUserIds(
    [
      // disagreement: Slate holds ID_A, Salesforce now names ID_B for the address
      row("u-dis", "dis@x.com", ID_A),
      // ambiguous: two Salesforce users answer to one address
      row("u-amb", "shared@x.com"),
      // claimed: resolves to ID_C, which another Slate row already holds
      row("u-cla", "claimer@x.com"),
      row("u-holder", "holder@x.com", ID_C),
    ],
    [
      cand("dis@x.com", ID_B),
      cand("shared@x.com", "005000000000004AAA"),
      cand("shared@x.com", "005000000000005AAA"),
      cand("claimer@x.com", ID_C),
      cand("holder@x.com", ID_C),
    ],
  );
  eq(plan.ambiguous.length, 1, "the ambiguous shape is planned");
  eq(plan.ambiguous[0].userIds, ["u-amb"], "and names the Slate row that hit it");

  const fields = userIdConflictLogFields(plan);
  const expected: Record<(typeof USER_ID_CONFLICT_SHAPES)[number], string> = {
    disagreements: "u-dis",
    ambiguous: "u-amb",
    claimed: "u-cla",
  };
  for (const shape of USER_ID_CONFLICT_SHAPES) {
    const entry = fields.find((f) => f.shape === shape);
    assert(entry !== undefined, `the log line has an entry for the ${shape} shape`);
    eq(entry?.count, 1, `the ${shape} count is on the line`);
    assert(
      (entry?.userIds ?? "").split(", ").includes(expected[shape]),
      `the ${shape} rows are named on the line (${entry?.idsKey})`,
    );
  }
  const keys = fields.map((f) => f.idsKey);
  eq(new Set(keys).size, keys.length, "each shape names its rows under its own field");
  // The two existing field names are what a saved log query searches on.
  assert(keys.includes("disagreeing_user_ids"), "disagreements keep their field name");
  assert(keys.includes("claimed_user_ids"), "claimed keeps its field name");
  assert(keys.includes("ambiguous_user_ids"), "ambiguous rows are named under ambiguous_user_ids");
  // Slate ids only: no email or Salesforce id reaches the line (L222).
  const rendered = JSON.stringify(fields);
  assert(!rendered.includes("@"), "no email reaches the line");
  assert(!rendered.includes("005000"), "no Salesforce id reaches the line");
}

// Two Slate rows sharing one ambiguous address are ONE entry naming BOTH rows.
{
  const plan = planSalesforceUserIds(
    [row("u1", "shared@x.com"), row("u2", "Shared@X.com")],
    [cand("shared@x.com", ID_A), cand("shared@x.com", ID_B)],
  );
  eq(plan.ambiguous.length, 1, "one entry per ambiguous address");
  eq(plan.ambiguous[0].userIds, ["u1", "u2"], "naming every row that hit it");
}

finish();
