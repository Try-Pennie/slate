/**
 * The roster rows Salesforce no longer confirms, and why (#1833). Pure.
 *
 * The hourly roster query returns the people Salesforce still matches. Everybody
 * else in Slate is simply never written again: no error, no counter, no log line,
 * and the lane reports success every hour. Their stored attributes freeze at
 * whatever the last matching run wrote, and the only visible symptom is Slate
 * presenting a stale copy as current fact. Measured against production on
 * 2026-09-13: 39 of 129 live rows had not been refreshed for over three days and
 * 12 had never been, while every run of the lane reported success.
 *
 * **This RECORDS the divergence, it never clears the attributes.** Salesforce
 * going quiet about somebody is not Salesforce saying their facts are gone (L214),
 * and the two directions are not equally recoverable: withholding a change is,
 * and emptying every pool an agent belongs to on a partial or narrowed Salesforce
 * read is not. That is the same call `src/lib/twilio/sync.ts` already makes for
 * the rows Twilio holds no worker for (`withoutWorker`), and there is one
 * convention here rather than two (L263, L370).
 *
 * The four causes are separate because they send a reader to four different
 * places (L11): somebody who left Salesforce, somebody Salesforce still holds and
 * whose flags were cleared (the case this issue was opened about, which is how a
 * person is taken off rotation for leave), an address Salesforce has never heard
 * of, and an address answering to records that disagree (#2387).
 */
import { normalizeEmail } from "@/lib/auth/email";
import type { SalesforceStanding } from "@/lib/salesforce/presence";

/** Why a Slate row was not written by this run's roster pass. */
export type UnconfirmedCause =
  /** Salesforce holds their record and reports IsActive = false. */
  | "inactive"
  /**
   * Salesforce holds them, active, and the roster query no longer matches them.
   * This is #1833 itself: clearing somebody's balance tier flags is how they are
   * taken off rotation, and it drops them out of the query rather than updating
   * them.
   */
  | "unmatched"
  /** Salesforce returned no record at all for their address. */
  | "absent"
  /**
   * The address answers to more than one Salesforce record and they disagree,
   * with nothing stored to say which one is this row's (#2387). A refusal rather
   * than a verdict, and the same one the reap reaches for the same address.
   */
  | "ambiguous";

/** One Slate roster row, as this reconcile needs to see it. */
export interface RosterRowForDivergence {
  id: string;
  email: string;
  bookable: boolean;
  deactivated: boolean;
  /** A synthetic smoke agent (#396), which has no Salesforce record by design. */
  isTest: boolean;
}

/**
 * The addresses the roster query returned.
 *
 * ADDRESSES, deliberately, and not the Salesforce user ids beside them. The
 * question this asks is "did the roster pass WRITE this row", and that pass
 * matches rows by email, so an address the query returned is the whole answer.
 *
 * Reading `salesforce_user_id` here as a second key would be worse than
 * redundant. A Slate row whose stored id Salesforce still returns under a
 * DIFFERENT address is a row holding an address Salesforce no longer has, which
 * the roster pass has already inserted a second row for; calling it confirmed on
 * the strength of the id would hide the duplicate while it goes on being stale.
 * Reported `absent` it is truthful, and the id link reports the other half of the
 * same situation as `salesforceIdClaimed`. It also keeps the one consumer rule
 * that column has: read it through `requireSalesforceUserId` or not at all, never
 * with a second hand rolled idea of what a missing key means (#1587, L263).
 */
export interface RosterQueryResult {
  emails: Set<string>;
}

/** The in scope rows the roster query did not return, and how many were looked at. */
export interface DivergenceScan {
  /**
   * In scope rows reconciled against Salesforce this run.
   *
   * Reported beside the findings on purpose: no findings over zero rows and no
   * findings over the whole roster read identically otherwise, and only the first
   * is a broken read (L98).
   */
  examined: number;
  candidates: RosterRowForDivergence[];
}

/**
 * One candidate with where it stands in Salesforce already read.
 *
 * The STANDING is handed in rather than worked out here, and that is the whole of
 * #2387. This reconcile used to read the presence map itself, with "an active
 * record wins" written in one branch, while the reap read the same map with "any
 * inactive record acts" written in another, so one address got two answers in one
 * run. There is one reading now (`readSalesforceStanding`) and both callers take
 * it, which also keeps the rule the stored key has: this file never touches that
 * column, and nothing here holds a second idea of what a missing one means
 * (#1587, L263).
 */
export interface DivergenceCandidate extends RosterRowForDivergence {
  standing: SalesforceStanding;
}

/** A `DivergenceScan` with every candidate's standing attached. */
export interface StandingsScan {
  examined: number;
  candidates: DivergenceCandidate[];
}

export interface UnconfirmedRow {
  userId: string;
  email: string;
  bookable: boolean;
  cause: UnconfirmedCause;
}

export interface RosterDivergencePlan {
  examined: number;
  rows: UnconfirmedRow[];
  inactive: number;
  unmatched: number;
  absent: number;
  /**
   * Unconfirmed, and the address could not be settled at all (#2387). Counted
   * apart from the three verdicts because it is not one: nothing was decided
   * about these people, and a refusal folded into a verdict is a refusal nobody
   * ever hears about (L11).
   */
  ambiguous: number;
  /**
   * The unconfirmed rows that are STILL BOOKABLE, by email.
   *
   * The only part of this that misroutes a lead. Everybody else is a stale row on
   * an admin screen, which is worth counting and is not worth a page every hour
   * (L36): measured on 2026-09-13 all 39 unconfirmed rows were non bookable.
   */
  bookable: string[];
}

/**
 * The in scope rows this run's roster query did not return.
 *
 * Deactivated and smoke test rows are out of scope, the same two exclusions
 * `planTwilioRoster` makes: nothing routes to either, and a smoke agent has no
 * Salesforce record by construction, so counting them would put a permanent
 * finding in front of a reader with nothing to do about it (L36).
 */
export function scanForDivergence(
  rows: RosterRowForDivergence[],
  roster: RosterQueryResult,
): DivergenceScan {
  let examined = 0;
  const candidates: RosterRowForDivergence[] = [];
  for (const row of rows) {
    if (row.deactivated || row.isTest) continue;
    const email = normalizeEmail(row.email ?? "");
    // Nothing can be asked about an address that is not one, and the roster loop
    // skips these rows for the same reason.
    if (!email) continue;
    examined += 1;
    if (roster.emails.has(email)) continue;
    candidates.push({ ...row, email });
  }
  return { examined, candidates };
}

/** How one standing reads as a reason this row was not written. */
const CAUSE_BY_STANDING: Record<SalesforceStanding, UnconfirmedCause> = {
  // Salesforce returned no record at all, which is a finding of its own and never
  // collapsed into "not active".
  absent: "absent",
  // Salesforce still holds them, active, and the roster query stopped matching
  // them. #1833's own case.
  held: "unmatched",
  departed: "inactive",
  ambiguous: "ambiguous",
};

/**
 * Give every candidate its cause.
 *
 * Every branch of the reading itself lives in `readSalesforceStanding`, so this is
 * a translation into this reconcile's vocabulary and nothing more: the point of
 * #2387 is that there is exactly one place where a shared address is interpreted.
 * A candidate whose standing is `absent` is still reported rather than dropped, so
 * a Salesforce answer that held nothing reports every candidate instead of an all
 * clear. The read itself throws on a real failure, which is what stops a failed
 * read reaching here at all.
 */
export function planRosterDivergence(scan: StandingsScan): RosterDivergencePlan {
  const rows: UnconfirmedRow[] = [];
  let inactive = 0;
  let unmatched = 0;
  let absent = 0;
  let ambiguous = 0;
  for (const candidate of scan.candidates) {
    const cause = CAUSE_BY_STANDING[candidate.standing];
    if (cause === "absent") absent += 1;
    else if (cause === "unmatched") unmatched += 1;
    else if (cause === "inactive") inactive += 1;
    else ambiguous += 1;
    rows.push({
      userId: candidate.id,
      email: candidate.email,
      bookable: candidate.bookable,
      cause,
    });
  }
  return {
    examined: scan.examined,
    rows,
    inactive,
    unmatched,
    absent,
    ambiguous,
    bookable: rows.filter((r) => r.bookable).map((r) => r.email),
  };
}
