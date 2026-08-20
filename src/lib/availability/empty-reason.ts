/**
 * Why the booker has nothing to offer (#1328).
 *
 * With no times, the booker said "All times are taken right now. Check back soon."
 * Both halves are untrue whenever the reason is a CLOSURE rather than demand:
 * nothing is taken, we are shut, and "soon" may be a week. A lead reads it as a
 * busy week, comes back tomorrow to the same screen, and is never told anything.
 *
 * Pure (luxon only, no `@/` imports) so the node suite drives it directly.
 */
import { DateTime } from "luxon";
import {
  windowOnDate,
  type BusinessHoursException,
  type BusinessWindow,
} from "../booking/business-hours.ts";
import { searchWindowDays } from "./bookable-days.ts";

export type EmptyReason =
  | {
      /** Every day we looked at is a day the org is shut. */
      kind: "closed";
      /** The first day we are open again, as an ISO date in the org's zone.
       *  Null when no weekday is open at all, which is a misconfiguration rather
       *  than a closure, and must not be reported as a date. */
      reopensOn: string | null;
    }
  /** The org was open on at least one searched day and still produced nothing:
   *  either genuinely full, or nobody rostered. Either way not a closure. */
  | { kind: "busy" };

/** How far ahead to look for the reopening day. A month is generous for a holiday
 *  shutdown and bounded, so a misconfigured week cannot walk forever. */
const REOPEN_SEARCH_DAYS = 31;

/**
 * Decide why an empty result is empty.
 *
 * "Closed" means every day in the window the booker actually searched is a shut
 * weekday. If ANY searched day was open, the emptiness is about supply, not about
 * opening hours, and saying we are closed would be its own lie.
 *
 * `openWeekdays` comes from the org's stored business hours (Luxon weekdays,
 * 1 = Monday), which the availability path already has in hand, so this needs no
 * extra read.
 */
export function emptyReason(input: {
  /** Open windows only, as `loadBusinessHours` returns them. */
  businessHours: BusinessWindow[];
  /**
   * The date exceptions (#1363). A holiday shutdown is the case this whole
   * message was written for and the one the weekly pattern alone could never
   * see: during Christmas week the weekdays are open, so the emptiness read as
   * demand and the lead was told every time was taken.
   */
  exceptions: BusinessHoursException[];
  /** Start of the searched window, an ISO date in the org's zone. */
  fromDay: string;
  /** How many calendar days were searched, inclusive of `fromDay`. */
  searchedDays: number;
  zone: string;
}): EmptyReason {
  const hours = { rules: input.businessHours, exceptions: input.exceptions };
  const start = DateTime.fromISO(input.fromDay, { zone: input.zone });
  if (!start.isValid || input.searchedDays <= 0) return { kind: "busy" };
  // One judge for "is the org open on this date", the same one the gate and the
  // read-time filter use, so a date the booker refuses can never be a date this
  // message calls open (L107).
  const openOn = (d: DateTime) => windowOnDate(hours, d.toISODate() ?? "", d.weekday) !== null;

  for (let i = 0; i < input.searchedDays; i++) {
    if (openOn(start.plus({ days: i }))) {
      // At least one searched day was open, so this is supply, not a closure.
      return { kind: "busy" };
    }
  }

  // Every searched day was shut. Walk on for the reopening day, which is the one
  // fact that makes the message actionable rather than just honest.
  for (let i = input.searchedDays; i < REOPEN_SEARCH_DAYS; i++) {
    const day = start.plus({ days: i });
    if (openOn(day)) {
      return { kind: "closed", reopensOn: day.toISODate() };
    }
  }
  // No open weekday within the month: the week is misconfigured (or every day is
  // shut), and naming a date we invented would be worse than naming none.
  return { kind: "closed", reopensOn: null };
}


/**
 * The org's week and horizon as the availability path holds them, either of which
 * may be absent because the read that produces it failed.
 */
export interface EmptyWindowInputs {
  hours: { zone: string; rules: BusinessWindow[]; exceptions: BusinessHoursException[] } | null;
  horizonDays: number | null;
  nowMs: number;
}

/**
 * A reason, or the thing that stopped one being worked out.
 *
 * `blockedBy` is not decoration. "Could not tell" and "nothing to tell" produce
 * the same null, and the whole of #1420 is that those two are indistinguishable
 * once they leave this function, so the blocker travels with the null.
 */
export type EmptyWindowExplanation =
  | { reason: EmptyReason; blockedBy: null }
  | { reason: null; blockedBy: string };

/**
 * Why an empty window is empty, given the config as it stands (#1328, #1420).
 *
 * THE function, asked by the availability route (which serves the answer to a
 * lead) and by the monitor lane (which watches whether an answer is reachable at
 * all). Two callers, one predicate: a lane that reimplemented the route's
 * assembly here could only ever confirm its own copy of it, and would agree with
 * the route right up until the two drifted (L107).
 *
 * The lane matters because of what this returning null COSTS. The lead is shown
 * "We could not work out what is available right now", which is honest and is
 * exactly why the fault stays invisible: it pages nobody, and a funnel that has
 * gone quiet looks like a quiet day. Measured only on the read, it would conclude
 * only when a lead is present, which before cutover is never, and a detector that
 * has never once concluded looks identical to one finding nothing wrong (#1394).
 */
export function explainEmptyWindow(input: EmptyWindowInputs): EmptyWindowExplanation {
  const unread: string[] = [];
  if (!input.hours) unread.push("the org's business hours");
  if (input.horizonDays === null) unread.push("the booking horizon");
  if (unread.length > 0) {
    // EVERY unread input, not just the first: naming one sends the reader back for
    // a second tick to discover the rest.
    const list = unread.length === 1 ? unread[0] : `${unread[0]} and ${unread[1]}`;
    return { reason: null, blockedBy: `${list} could not be read` };
  }
  const hours = input.hours!;
  const fromDay = DateTime.fromMillis(input.nowMs).setZone(hours.zone).toISODate();
  if (!fromDay) {
    // Its own cause, and its own sentence. The week READ perfectly well, so
    // reporting this as an unreadable week would send whoever is holding the pager
    // to the wrong screen entirely (L11).
    return {
      reason: null,
      blockedBy: `the org's business hours are unusable (timezone ${hours.zone})`,
    };
  }
  return {
    reason: emptyReason({
      businessHours: hours.rules,
      exceptions: hours.exceptions,
      fromDay,
      // The same window the slots were searched over, so "every day we looked at
      // was shut" means exactly that rather than some other span.
      searchedDays: searchWindowDays(input.horizonDays!),
      zone: hours.zone,
    }),
    blockedBy: null,
  };
}
