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
 * The three causes are separate because they send a reader to three different
 * places (L11): somebody who left Salesforce, somebody Salesforce still holds and
 * whose flags were cleared (the case this issue was opened about, which is how a
 * person is taken off rotation for leave), and an address Salesforce has never
 * heard of.
 */
import { normalizeEmail } from "@/lib/auth/email";

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
  | "absent";

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

/**
 * What Salesforce holds for one address, kept as BOTH facts rather than one
 * verdict.
 *
 * A shared address answering to two Salesforce users is a real state (it is the
 * `salesforceIdAmbiguous` case the id link already reports), and the reap and
 * this reconcile want opposite readings of it: the reap deactivates on ANY
 * inactive record, which is the rule it has always applied, and this reads an
 * active record as somebody Salesforce still holds. Folding the two into one
 * boolean here would silently change one of them.
 */
export interface SalesforcePresence {
  anyActive: boolean;
  anyInactive: boolean;
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
   * The unconfirmed rows that are STILL BOOKABLE, by email.
   *
   * The only part of this that misroutes a lead. Everybody else is a stale row on
   * an admin screen, which is worth counting and is not worth a page every hour
   * (L36): measured on 2026-09-13 all 39 unconfirmed rows were non bookable.
   */
  bookable: string[];
}

/**
 * Fold Salesforce's answer about a set of addresses into a presence map.
 *
 * An address MISSING from the result is missing from the map, which is what lets
 * "Salesforce has no record for them" stay a distinct finding rather than
 * collapsing into "not active".
 */
export function presenceFromRecords(
  records: { email: string; isActive: boolean }[],
): Map<string, SalesforcePresence> {
  const out = new Map<string, SalesforcePresence>();
  for (const record of records) {
    const email = normalizeEmail(record.email ?? "");
    if (!email) continue;
    const current = out.get(email) ?? { anyActive: false, anyInactive: false };
    out.set(email, {
      anyActive: current.anyActive || record.isActive === true,
      anyInactive: current.anyInactive || record.isActive !== true,
    });
  }
  return out;
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

/**
 * Give every candidate its cause.
 *
 * An address the presence map does not hold is `absent` rather than dropped, so a
 * Salesforce read that returned nothing reports every candidate instead of
 * reporting an all clear. The read itself throws on a real failure, which is what
 * stops a failed read reaching here at all.
 */
export function planRosterDivergence(
  scan: DivergenceScan,
  presence: Map<string, SalesforcePresence>,
): RosterDivergencePlan {
  const rows: UnconfirmedRow[] = [];
  let inactive = 0;
  let unmatched = 0;
  let absent = 0;
  for (const candidate of scan.candidates) {
    const held = presence.get(candidate.email);
    let cause: UnconfirmedCause;
    if (!held) {
      cause = "absent";
      absent += 1;
    } else if (held.anyActive) {
      // Active wins over a second inactive record for the same address: somebody
      // Salesforce still holds as active is not somebody who left.
      cause = "unmatched";
      unmatched += 1;
    } else {
      cause = "inactive";
      inactive += 1;
    }
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
    bookable: rows.filter((r) => r.bookable).map((r) => r.email),
  };
}
