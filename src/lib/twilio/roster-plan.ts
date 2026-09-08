// Who the roster sync flips out of the bookable pool because Twilio says
// Redistribute, and who it flips back in (#2097). PURE: driven offline by
// `scripts/test-twilio-redistribute-plan.ts`.
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
import { REDISTRIBUTE_MARK, type TwilioSide } from "@/lib/twilio/roster";

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
   */
  attributes: Attributes;
}

export interface RedistributePlan {
  flips: PlannedRedistribute[];
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

/**
 * Decide every flip, from the roster Slate holds and the workers Twilio answered
 * with.
 *
 * `twilioByEmail` is keyed on the lowercased address, as `readWorker` produces it.
 * An EMPTY map flips nobody in either direction: the caller refuses a read that
 * returned no workers before ever getting here, and this is the second half of that
 * refusal, because an empty map must never read as "nobody is tagged any more".
 */
export function planRedistribute(
  rows: TwilioRosterRow[],
  twilioByEmail: Map<string, TwilioSide>,
): RedistributePlan {
  const flips: PlannedRedistribute[] = [];
  const markedWithNoWorker: string[] = [];

  for (const row of rows) {
    if (row.deactivated || row.isTest) continue;
    const email = row.email.trim().toLowerCase();
    const worker = twilioByEmail.get(email) ?? null;
    const marked = isMarkedRedistribute(row.attributes);

    if (worker?.redistribute) {
      // Twilio withholds them. Only a flip is planned, and only from inside the
      // pool: an agent already out of it is left exactly as they are.
      if (row.bookable) {
        flips.push({ userId: row.id, email, action: "turn-off", attributes: withMark(row.attributes) });
      }
      continue;
    }
    if (!marked) continue;
    if (!worker) {
      markedWithNoWorker.push(email);
      continue;
    }
    // Marked, and Twilio has a worker for them that no longer carries the tag.
    // Planned even when the row is already bookable, because the mark is then
    // stale and the flip is what clears it.
    flips.push({ userId: row.id, email, action: "turn-back-on", attributes: withoutMark(row.attributes) });
  }

  return { flips, markedWithNoWorker };
}
