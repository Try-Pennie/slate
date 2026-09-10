// How a new hire becomes bookable, decided in one pure place (#2071). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-salesforce-onboarding.ts
//
// Measured on 2026-09-08: four agents hired since the roster flip sat non-bookable
// in Slate with Low Debt ticked in Salesforce and cal.com already routing to two
// of them, and four more sat in Salesforce on the Chatter Free profile with no
// Slate row at all. Both states are correct under the old rule (a tier creates
// the row, a human flips it) and both were invisible, because a non-bookable row
// is a legitimate state and a missing row leaves no trace.
//
// The rule Dan gave: a hire arrives in Salesforce on Chatter Free with no debt
// team and is added to Slate not bookable; the first time they are moved to Sales
// or given a debt team, they become bookable. Nothing ever switches somebody OFF
// on its own, and a person's deliberate hold (a manager with tiers who was set
// non-bookable by hand) is never overturned, because the trigger is a TRANSITION
// and not a level.
import {
  AGENT_PROFILES,
  agentProfileSoql,
  qualifiesForBooking,
  tieredButNotOnSales,
  planOnboardingFlip,
} from "@/lib/salesforce/onboarding";
import { assert, eq, finish } from "./lib/harness.ts";

const chatter = { role: "Chatter Free User" };
const salesNoTier = { role: "Sales" };
const salesLow = { role: "Sales", debt_team: ["low"], backend_service: ["achieve"] };
const chatterLow = { role: "Chatter Free User", debt_team: ["low"] };
const managerTiers = { role: "Sales Manager", debt_team: ["medium", "high", "very_high"] };

const live = { bookable: false, deactivated: false, pending: false };

// --- who is created at all -----------------------------------------------------------
{
  assert(AGENT_PROFILES.includes("Chatter Free User"), "a hire on the Chatter Free profile is created");
  assert(AGENT_PROFILES.includes("Sales"), "so is anybody on the Sales profile, tiers or not");
  const soql = agentProfileSoql();
  for (const p of AGENT_PROFILES) assert(soql.includes(`'${p}'`), `the query names ${p}`);
  assert(/Profile\.Name IN \(/.test(soql), "as an IN list on the profile name");
}

// --- what counts as ready to book ----------------------------------------------------
{
  eq(qualifiesForBooking(chatter), false, "Chatter Free with no tier does not qualify");
  eq(qualifiesForBooking(salesNoTier), true, "the Sales profile is what qualifies somebody");
  // #2182: a tier says what somebody can be ROUTED FOR, never that they are taking
  // calls. It comes from Twilio since #2152, and Dan's call is that becoming
  // bookable stays a Salesforce decision.
  eq(qualifiesForBooking(chatterLow), false, "a debt team on another profile does NOT qualify");
  eq(qualifiesForBooking({}), false, "no attributes at all does not qualify");
  eq(qualifiesForBooking({ role: "Sales", debt_team: [] }), true, "Sales with an empty tier list still qualifies");
}

// --- the transition, and only the transition -----------------------------------------
{
  eq(planOnboardingFlip({ prev: chatter, next: salesNoTier, ...live }).action, "flip", "Chatter Free to Sales flips");
  // #2182: a first debt team no longer flips anybody. It comes from Twilio since
  // #2152, and a tag there says what somebody can be ROUTED FOR, never that they
  // are taking calls.
  eq(planOnboardingFlip({ prev: chatter, next: chatterLow, ...live }).action, "none", "a first tier on Chatter Free flips nobody");
  eq(planOnboardingFlip({ prev: chatter, next: salesNoTier, ...live }).reason, "sales-profile", "a profile move says that is why");
  eq(planOnboardingFlip({ prev: chatter, next: salesLow, ...live }).reason, "sales-profile", "both at once is the profile move, which is the half that flips");

  eq(planOnboardingFlip({ prev: chatter, next: chatter, ...live }).action, "none", "no change, no flip");
  // rvillar: a manager holding tiers, set non-bookable by a person on 2026-09-02.
  eq(
    planOnboardingFlip({ prev: managerTiers, next: managerTiers, ...live }).action,
    "none",
    "tiers to tiers is a level, not a transition, so a human hold is never overturned",
  );
  eq(
    planOnboardingFlip({ prev: salesLow, next: { role: "Sales", debt_team: ["low", "medium"] }, ...live }).action,
    "none",
    "gaining a second tier changes nothing, as gaining the first no longer does either",
  );

  // #2182: the state this narrowing creates, and the reason the roster sync counts
  // it. Somebody left on Chatter Free with tiers is waiting on a Salesforce edit
  // nobody has been told is owed, and nothing in here will ever advance them.
  assert(tieredButNotOnSales(chatterLow), "tiers on a non-Sales profile is a person waiting on Salesforce");
  assert(!tieredButNotOnSales(salesLow), "somebody already on Sales is not waiting for anything");
  assert(!tieredButNotOnSales(chatter), "and neither is a hire with no tiers yet");
}

// --- a brand new row ---------------------------------------------------------------------
{
  eq(planOnboardingFlip({ prev: null, next: chatter, ...live }).action, "none", "a hire arriving on Chatter Free waits");
  eq(planOnboardingFlip({ prev: null, next: salesLow, ...live }).action, "flip", "a hire arriving already on Sales with a tier flips at once");
  eq(planOnboardingFlip({ prev: null, next: salesLow, ...live }).reason, "sales-profile", "and says why");
}

// --- states that always say no -----------------------------------------------------------
{
  eq(
    planOnboardingFlip({ prev: chatter, next: salesLow, bookable: true, deactivated: false, pending: false }).action,
    "none",
    "already bookable, nothing to do",
  );
  eq(
    planOnboardingFlip({ prev: chatter, next: salesLow, bookable: false, deactivated: true, pending: false }).action,
    "none",
    "somebody who has left is never put back in the pool by a Salesforce edit",
  );
}

// --- the retry -----------------------------------------------------------------------------
// The transition happens once. If the flip was refused that hour (no Google calendar
// yet), the next hour sees tiers against tiers, which is exactly the shape of a
// deliberate human hold above. The pending mark is what tells the two apart.
{
  const retry = planOnboardingFlip({ prev: salesLow, next: salesLow, bookable: false, deactivated: false, pending: true });
  eq(retry.action, "flip", "a pending flip is retried however the attributes look");
  eq(retry.reason, "retry", "and is reported as a retry rather than a fresh transition");
  eq(
    planOnboardingFlip({ prev: salesLow, next: salesLow, bookable: false, deactivated: true, pending: true }).action,
    "none",
    "but never for somebody who has left",
  );
}

// --- run it twice ---------------------------------------------------------------------------
// Same inputs, same answer: the sync can crash and re-run without inventing a
// second decision.
{
  const a = planOnboardingFlip({ prev: chatter, next: salesLow, ...live });
  const b = planOnboardingFlip({ prev: chatter, next: salesLow, ...live });
  eq(JSON.stringify(a), JSON.stringify(b), "the plan is a pure function of its inputs");
}

finish();
