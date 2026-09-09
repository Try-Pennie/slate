// What the roster sync writes for one person, from what Twilio says about them:
// the bookable flip Redistribute demands (#2097) and the legal eligibility value
// (#2098). PURE: driven offline by `scripts/test-twilio-roster-plan.ts`.
//
// THE TWO FACTS ARE PLANNED TOGETHER, and that is the reason this is one function
// rather than two. Both live in the same `users.attributes` JSON column, so two
// planners would each build a payload from the same base row and the second write
// would silently drop the first (L443). Here every payload is derived once, from
// one read, and a row is never in both lists.
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

/** What Slate holds for one person, as far as this decision is concerned. */
export interface TwilioRosterRow {
  id: string;
  email: string;
  bookable: boolean;
  /** Left the pool for good. Flipped neither way, and never reported as waiting. */
  deactivated: boolean;
  /** The SMOKE canary agents (#396), which no real Twilio tag may ever touch. */
  isTest: boolean;
  attributes: Attributes | null;
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
  /**
   * The legal value inside that payload, and whether it MOVED.
   *
   * Carried so the caller can report the change only once the write has landed.
   * Without `changed`, a run would either claim a legal change for every agent it
   * flipped or lose the ones where it really moved.
   */
  legal: { value: LegalEligible; changed: boolean };
}

/**
 * A legal eligibility value to write for somebody the run is NOT flipping (#2098).
 *
 * Kept apart from the flips because a row is never in both: a flip's payload
 * already carries the legal value, so applying both would be two writes over one
 * column from one base.
 */
export interface LegalWrite {
  userId: string;
  email: string;
  value: LegalEligible;
  /** The whole attributes object to write, merged over the row's own. */
  attributes: Attributes;
}

export interface RedistributePlan {
  flips: PlannedRedistribute[];
  /** Legal eligibility values to write for rows this run is not flipping. */
  legalWrites: LegalWrite[];
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
   * redistribute mark does on an absence, and the asymmetry is deliberate, since
   * withholding somebody is recoverable and admitting them is not.
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

function withMark(attributes: Attributes | null): Attributes {
  return { ...(attributes ?? {}), redistribute: REDISTRIBUTE_MARK };
}

function withoutMark(attributes: Attributes | null): Attributes {
  const next = { ...(attributes ?? {}) };
  delete next.redistribute;
  return next;
}

/** The stored legal value, in the one shape the comparison and the write agree on. */
function storedLegal(attributes: Attributes | null | undefined): string {
  const v = attributes?.legal_eligible;
  return v === undefined || v === null ? "" : String(v);
}

function withLegal(attributes: Attributes | null, value: LegalEligible): Attributes {
  return { ...(attributes ?? {}), legal_eligible: value };
}

/**
 * Decide every flip, from the roster Slate holds and the workers Twilio answered
 * with.
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
): RedistributePlan {
  const flips: PlannedRedistribute[] = [];
  const legalWrites: LegalWrite[] = [];
  const markedWithNoWorker: string[] = [];
  const withoutWorker: string[] = [];

  for (const row of rows) {
    if (row.deactivated || row.isTest) continue;
    const email = row.email.trim().toLowerCase();
    const worker = twilioByEmail.get(email) ?? null;
    const marked = isMarkedRedistribute(row.attributes);
    if (!worker) withoutWorker.push(email);

    // The legal value first, so whatever payload this row ends up with carries it.
    // A worker Twilio holds nothing for is excluded, because the default is N
    // (Dan, 2026-09-09) and that is the direction that cannot misroute a lead.
    const wantLegal = worker ? twilioLegalEligible(worker) : LEGAL_ELIGIBLE_NO;
    const legalChanged = storedLegal(row.attributes) !== (wantLegal as string);
    const base = legalChanged ? withLegal(row.attributes, wantLegal) : (row.attributes ?? {});

    if (worker?.redistribute) {
      // Twilio withholds them. Only a flip is planned, and only from inside the
      // pool: an agent already out of it is left exactly as they are.
      if (row.bookable) {
        flips.push({
          userId: row.id,
          email,
          action: "turn-off",
          attributes: withMark(base),
          legal: { value: wantLegal, changed: legalChanged },
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
          legal: { value: wantLegal, changed: legalChanged },
        });
        continue;
      }
    }

    // No flip carries this row's payload, so the legal value needs its own write.
    if (legalChanged) legalWrites.push({ userId: row.id, email, value: wantLegal, attributes: base });
  }

  return { flips, legalWrites, markedWithNoWorker, withoutWorker };
}
