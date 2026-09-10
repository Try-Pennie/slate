// What the roster sync writes for one person, from what Twilio says about them:
// the bookable flip Redistribute demands (#2097), the legal eligibility value
// (#2098), and since #2152 the debt tiers and backend service themselves.
// PURE: driven offline by `scripts/test-twilio-roster-plan.ts`.
//
// EVERY FACT IS PLANNED TOGETHER, and that is the reason this is one function
// rather than four. They all live in the same `users.attributes` JSON column, so
// separate planners would each build a payload from the same base row and the last
// write would silently drop the rest (L443). Here every payload is derived once,
// from one read, and a row is never in two lists.
//
// TIERS AND BACKEND ARE MIRRORED WHOLESALE, exactly as Salesforce used to mirror
// them: the values Twilio carries replace whatever is stored, and a tag that has
// gone takes its value with it. A tier left behind because nothing removes it is an
// agent in a pool the source says they are not in, which is the failure this issue
// exists to end. Measured against production on 2026-09-10 before shipping: of 129
// in scope rows every one had a Twilio worker, two differed, and the only bookable
// account among them was the admin's own.
//
// THE ONE ASYMMETRY, and it is deliberate. A row Twilio holds NO worker for keeps
// its stored tiers untouched, while its legal value is written to N. Silence about
// somebody is not the same as a source saying the value is gone (L214), and the two
// directions are not equally recoverable: withholding legal work is, and emptying
// every pool an agent belongs to on a partial read is not. `withoutWorker` counts
// them, because doing nothing is otherwise invisible.
//
// A `Redistribute` tag means the agent should not be taking booked calls (Dan,
// 2026-09-08). It exists only in Twilio, so this is the only place Slate can learn
// it, and until #2096 there was no way to see it at all.
//
// THE REVERSE FLIP IS A TRANSITION, NEVER A LEVEL (L60). Twilio's answer for
// somebody who should be bookable and somebody who has never been bookable is the
// same answer: no tag. Almost the whole roster is untagged, so a plan that flipped
// every untagged agent ON reads as a mirror of Twilio and is actually a mass
// activation: it would admit every new hire with no debt team and overturn every
// agent an admin turned off by hand.
//
// So Slate records the people IT turned off, in `attributes.redistribute`, and only
// a marked row is ever flipped back on. Two consequences worth stating, because
// both were decided rather than fallen into:
//
//  - An agent who is ALREADY not bookable and carries the tag is left alone and
//    NOT marked. Slate did not put them out of the pool, so it has no business
//    putting them back. This is also what keeps the activation gate quiet: a flip
//    ON is refused for an agent with no Google calendar and re-alerts every hour
//    (#2078), and two of the four withheld agents who are currently not bookable
//    have no calendar row at all.
//  - The gap that leaves, somebody cal.com would route to and Slate will not, is
//    not invisible: `pnpm verify:calcom-parity` reports it as exit 24, which is the
//    command whose job that comparison is.
import type { Attributes } from "@/lib/db/types";
import {
  REDISTRIBUTE_MARK,
  LEGAL_ELIGIBLE_NO,
  twilioLegalEligible,
  type LegalEligible,
  type TwilioSide,
} from "@/lib/twilio/roster";
import type { BackendValue, DebtTierValue } from "@/lib/routing/attribute-vocabulary";
import { planOnboardingFlip } from "@/lib/salesforce/onboarding";

/** What Slate holds for one person, as far as this decision is concerned. */
export interface TwilioRosterRow {
  id: string;
  email: string;
  bookable: boolean;
  /**
   * `bookable_pending_since` is set: an activation was already planned and refused.
   *
   * Read so this planner never plans it AGAIN. The retry belongs to the Salesforce
   * half, which retries every pending row it sees whatever the attributes now say,
   * and two owners for one retry is two flips an hour for one intent.
   */
  pending: boolean;
  /** Left the pool for good. Flipped neither way, and never reported as waiting. */
  deactivated: boolean;
  /** The SMOKE canary agents (#396), which no real Twilio tag may ever touch. */
  isTest: boolean;
  attributes: Attributes | null;
}

/**
 * One fact Twilio owns, as this run found it: the value to store, and whether it
 * MOVED.
 *
 * `changed` is carried rather than recomputed by the caller so a change can be
 * reported only once its write has landed. Without it a run would either claim a
 * change for every agent it touched or lose the ones where the value really moved
 * (#1134).
 */
export interface PlannedValue<T> {
  value: T;
  changed: boolean;
}

/** Everything Twilio says about one person, and what moved. */
export interface TwilioChanges {
  legal: PlannedValue<LegalEligible>;
  debtTeams: PlannedValue<DebtTierValue[]>;
  backendServices: PlannedValue<BackendValue[]>;
}

/** True when this row's payload changes anything at all. */
function changesAnything(c: TwilioChanges): boolean {
  return c.legal.changed || c.debtTeams.changed || c.backendServices.changed;
}

export type RedistributeAction = "turn-off" | "turn-back-on";

export interface PlannedRedistribute {
  userId: string;
  email: string;
  action: RedistributeAction;
  /**
   * The attributes to write with the flip, already merged over the row's own.
   *
   * Carried here rather than composed at the call site so the mark has ONE
   * spelling: a caller writing its own `{ redistribute: "Y" }` is a second
   * definition of the same fact, and the two drift silently (L370).
   *
   * It also carries the legal eligibility value, because both facts live in the
   * same JSON column and two writes built from one base would drop each other.
   */
  attributes: Attributes;
  /** What Twilio says about them, and which of it moved. */
  changes: TwilioChanges;
  /**
   * The moment Slate marked them, for a `turn-off` only, and null on the way back
   * in (#2115).
   *
   * It is the coverage sweep's idempotency key AND the sweep's window start, and it
   * is READ BACK from the row whenever one is already stored: a run that died
   * between the mark and the flip leaves a marked and still bookable agent, and
   * minting a fresh stamp next hour would be a fresh key, so the unique index would
   * never fire and the sweep would run twice.
   */
  markedAtIso: string | null;
}

/**
 * The Twilio owned attributes to write for somebody the run is NOT flipping.
 *
 * Kept apart from the flips because a row is never in both: a flip's payload
 * already carries every value, so applying both would be two writes over one
 * column from one base.
 */
export interface AttributeWrite {
  userId: string;
  email: string;
  /** The whole attributes object to write, merged over the row's own. */
  attributes: Attributes;
  changes: TwilioChanges;
  /**
   * This write gives them their FIRST debt tier while they are out of the pool, so
   * the run should try to make them bookable (#2071, and #2152 for why it is here).
   *
   * The transition belongs to whoever WRITES the fact that causes it. Salesforce
   * owns it for the profile and owned it for the tier until Twilio took the tier
   * over; a sync that wrote the tier and left the flip to the other half would
   * detect nothing, because by the time that half read the row the tier would
   * already be there and "has a tier and is not bookable" is the shape of somebody
   * an admin deliberately held back (L60).
   *
   * The flip still goes through the activation gate, which refuses anybody with no
   * reachable Google calendar and leaves the pending mark for the Salesforce half
   * to retry.
   */
  activate: boolean;
}

export interface RedistributePlan {
  flips: PlannedRedistribute[];
  /** The attributes to write for rows this run is not flipping. */
  attributeWrites: AttributeWrite[];
  /**
   * Emails Slate marked and Twilio holds no worker for, so nothing can say whether
   * the tag was removed or the worker simply went away.
   *
   * Reported rather than acted on. A source that is PRESENT but silent about one
   * person is not the same as a source saying the tag is gone (L214), and treating
   * it as one would re-admit somebody on an absence. Doing nothing is correct here
   * and therefore invisible, which is why it is counted.
   */
  markedWithNoWorker: string[];
  /**
   * Every in scope Slate row Twilio holds no worker for.
   *
   * Reported because the legal value written for them is written on an ABSENCE:
   * Twilio said nothing, and the default is N, so they are excluded from legal
   * work by a source that never mentioned them. That is the opposite of what the
   * redistribute mark does on an absence, and of what the tiers do, which are left
   * exactly as stored. The asymmetry is deliberate in all three places, since
   * withholding somebody is recoverable and admitting them is not, and emptying
   * every pool they belong to is not either.
   *
   * It is also the only visible sign of a PARTIAL Twilio read. A read that
   * returned no workers at all is refused by the caller, but one that returned
   * half the roster would quietly exclude the other half, and this count is what
   * that looks like. Measured 2026-09-09 it is zero: all 125 live Slate users
   * have a Twilio worker.
   */
  withoutWorker: string[];
}

/** True when SLATE turned this person out of the pool because of the tag. */
export function isMarkedRedistribute(attributes: Attributes | null | undefined): boolean {
  return String(attributes?.redistribute ?? "") === REDISTRIBUTE_MARK;
}

function withMark(attributes: Attributes | null, markedAtIso: string): Attributes {
  return { ...(attributes ?? {}), redistribute: REDISTRIBUTE_MARK, redistribute_at: markedAtIso };
}

function withoutMark(attributes: Attributes | null): Attributes {
  const next = { ...(attributes ?? {}) };
  delete next.redistribute;
  // The stamp goes WITH the mark. Left behind, a later pool exit would key its
  // coverage sweep onto the stamp of the previous one, and the unique index would
  // refuse the new sweep while the old job explained nothing about it.
  delete next.redistribute_at;
  return next;
}

/**
 * The stamp already stored for this mark, or null when there is nothing usable.
 *
 * A value that is not a readable instant cannot key anything, so it is replaced
 * rather than carried into the database as a corrupt key. `Date.parse` answers NaN
 * for an unreadable string and every comparison with NaN is false, so this asks
 * `Number.isFinite` rather than letting the unreadable value through (L50).
 */
function storedMarkStamp(attributes: Attributes | null | undefined): string | null {
  const raw = attributes?.redistribute_at;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  return Number.isFinite(Date.parse(raw)) ? raw : null;
}

/** The stored legal value, in the one shape the comparison and the write agree on. */
function storedLegal(attributes: Attributes | null | undefined): string {
  const v = attributes?.legal_eligible;
  return v === undefined || v === null ? "" : String(v);
}

/**
 * Whether a stored list key already holds exactly what this run would write.
 *
 * Compared as the SERIALIZED value rather than as a set, for two reasons that a
 * set comparison gets wrong in opposite directions. Order is part of the value:
 * the vocabulary declares it (highest debt first) and two rows carrying the same
 * tiers in different orders are not the same row to anybody reading them (L228).
 * And a key holding something that is not a list at all (the boolean the retired
 * admin control used to write, #2120) must read as different from an empty write,
 * or the junk stays forever because "absent" and "unreadable" would compare equal.
 *
 * An ABSENT key and an EMPTY value are the one pair that compares equal, because
 * an agent with no tiers carries no `debt_team` key: that is what Salesforce wrote
 * before this and what every reader already expects.
 */
function listAlreadyStored(attributes: Attributes | null | undefined, key: string, next: readonly string[]): boolean {
  const attrs = (attributes ?? {}) as Record<string, unknown>;
  const stored = key in attrs ? JSON.stringify(attrs[key]) : null;
  return stored === (next.length > 0 ? JSON.stringify(next) : null);
}

/**
 * What Twilio says about this person, against what Slate holds.
 *
 * A row Twilio holds no worker for keeps its stored tiers (the header says why) and
 * is written to legal excluded, which is the deliberate asymmetry.
 */
function planChanges(attributes: Attributes | null, worker: TwilioSide | null): TwilioChanges {
  const legalValue = worker ? twilioLegalEligible(worker) : LEGAL_ELIGIBLE_NO;
  const debtTeams = worker ? worker.debtTeams : storedList<DebtTierValue>(attributes, "debt_team");
  const backendServices = worker ? worker.backendServices : storedList<BackendValue>(attributes, "backend_service");
  return {
    legal: { value: legalValue, changed: storedLegal(attributes) !== (legalValue as string) },
    debtTeams: { value: debtTeams, changed: !listAlreadyStored(attributes, "debt_team", debtTeams) },
    backendServices: {
      value: backendServices,
      changed: !listAlreadyStored(attributes, "backend_service", backendServices),
    },
  };
}

/** The list a row already holds, for the absence case where nothing replaces it. */
function storedList<T extends string>(attributes: Attributes | null | undefined, key: string): T[] {
  const v = (attributes ?? {})[key as keyof Attributes];
  return Array.isArray(v) ? (v as T[]) : [];
}

/**
 * The row's attributes with every Twilio owned value applied.
 *
 * An empty list DELETES its key rather than storing `[]`, because an agent with no
 * tiers has always carried no `debt_team` key at all and every reader was written
 * against that.
 */
function withTwilioFacts(attributes: Attributes | null, changes: TwilioChanges): Attributes {
  const next: Attributes = { ...(attributes ?? {}), legal_eligible: changes.legal.value };
  if (changes.debtTeams.value.length > 0) next.debt_team = [...changes.debtTeams.value];
  else delete next.debt_team;
  if (changes.backendServices.value.length > 0) next.backend_service = [...changes.backendServices.value];
  else delete next.backend_service;
  return next;
}

/**
 * Decide every flip, from the roster Slate holds and the workers Twilio answered
 * with.
 *
 * `nowIso` is injected rather than read from the clock, so the stamp a flip carries
 * is a value a test can assert on and two runs in one test cannot disagree.
 *
 * `twilioByEmail` is keyed on the lowercased address, as `readWorker` produces it.
 * An EMPTY map flips nobody in either direction: the caller refuses a read that
 * returned no workers before ever getting here, and this is the second half of that
 * refusal, because an empty map must never read as "nobody is tagged any more".
 *
 * It does NOT stop the legal writes, which is deliberate rather than an oversight:
 * an unseen row is written to N, and the caller's refusal is what stops a run
 * reaching here on a read that answered with nothing at all.
 */
export function planTwilioRoster(
  rows: TwilioRosterRow[],
  twilioByEmail: Map<string, TwilioSide>,
  nowIso: string,
): RedistributePlan {
  const flips: PlannedRedistribute[] = [];
  const attributeWrites: AttributeWrite[] = [];
  const markedWithNoWorker: string[] = [];
  const withoutWorker: string[] = [];

  for (const row of rows) {
    if (row.deactivated || row.isTest) continue;
    const email = row.email.trim().toLowerCase();
    const worker = twilioByEmail.get(email) ?? null;
    const marked = isMarkedRedistribute(row.attributes);
    if (!worker) withoutWorker.push(email);

    // Every Twilio owned value first, so whatever payload this row ends up with
    // carries all of them and nothing is written over the same column twice.
    const changes = planChanges(row.attributes, worker);
    const base = changesAnything(changes) ? withTwilioFacts(row.attributes, changes) : (row.attributes ?? {});

    if (worker?.redistribute) {
      // Twilio withholds them. Only a flip is planned, and only from inside the
      // pool: an agent already out of it is left exactly as they are.
      if (row.bookable) {
        const markedAtIso = storedMarkStamp(row.attributes) ?? nowIso;
        flips.push({
          userId: row.id,
          email,
          action: "turn-off",
          attributes: withMark(base, markedAtIso),
          changes,
          markedAtIso,
        });
        continue;
      }
    } else if (marked) {
      if (!worker) {
        markedWithNoWorker.push(email);
      } else {
        // Marked, and Twilio has a worker for them that no longer carries the tag.
        // Planned even when the row is already bookable, because the mark is then
        // stale and the flip is what clears it.
        flips.push({
          userId: row.id,
          email,
          action: "turn-back-on",
          attributes: withoutMark(base),
          changes,
          markedAtIso: null,
        });
        continue;
      }
    }

    // No flip carries this row's payload, so it needs its own write.
    //
    // The activation is asked on the SAME pair this write moves between, the
    // attributes as stored and the attributes about to be stored, which is the only
    // place the transition is visible (#2152). Somebody Twilio withholds is never
    // activated: `worker.redistribute` above has already left them out of the pool,
    // and reaching here means they were out of it before this run began.
    //
    // Only the TIER transition is taken. A pending row answers `retry`, which the
    // Salesforce half owns and would otherwise be attempted twice an hour by two
    // halves for one intent, and the profile transition is Salesforce's own fact.
    const onboarding = worker && !worker.redistribute
      ? planOnboardingFlip({
          prev: row.attributes ?? {},
          next: base,
          bookable: row.bookable,
          deactivated: row.deactivated,
          pending: row.pending,
        })
      : { action: "none" as const };
    const activate = onboarding.action === "flip" && onboarding.reason === "first-tier";

    if (changesAnything(changes) || activate) {
      attributeWrites.push({ userId: row.id, email, attributes: base, changes, activate });
    }
  }

  return { flips, attributeWrites, markedWithNoWorker, withoutWorker };
}
