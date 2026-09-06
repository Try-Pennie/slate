/**
 * Every sentence the erasure purge worklist can show an operator (#1124).
 *
 * Kept out of the component for the same reason the alert and booker copy is
 * (#1153, #1343): a string a person reads is a contract, and one living inline in
 * markup cannot be driven by a test or read without a browser. The component owns
 * the markup; this file owns the words.
 *
 * Two rules run through all of it:
 *
 *   - a state nobody measured never borrows the wording of a measured one. "The
 *     warehouse holds nothing" and "the warehouse did not answer" are different
 *     sentences, and the second never renders a zero.
 *   - a confirmation names the state it is about to change (L180). A fixed
 *     warning reads identically whether it is taking one booking or thirty, which
 *     is the same as no warning at all.
 *
 * PURE, and it reads no clock: the same inputs always produce the same text.
 */

import type {
  EntryStatus,
  ErasureWorklistEntry,
  WorklistSummary,
} from "./erasure-worklist";
import { ERASURE_RESPONSE_DAYS } from "./erasure-worklist";

const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`;

/** The page's one line answer to "is there anything to do here". */
export function worklistHeadline(summary: WorklistSummary): string {
  // Deliberately not the empty state's own sentence below it: a heading and the
  // paragraph under it saying the same words is a wasted line.
  if (summary.entries === 0) return "Nothing to purge yet.";
  if (summary.outstanding > 0) {
    const head = `${plural(summary.outstanding, "erasure")} still ${
      summary.outstanding === 1 ? "has" : "have"
    } contact data in the warehouse.`;
    // The AGE is what turns a count into something with a clock on it. Omitted
    // rather than defaulted when no outstanding stamp could be read, because a
    // headline naming zero days would be the reassuring reading of an unknown.
    return summary.oldestOutstandingDays === null
      ? head
      : `${head} The longest has been waiting ${plural(summary.oldestOutstandingDays, "day")}.`;
  }
  if (summary.unknown > 0) {
    return `${plural(summary.unknown, "erasure")} could not be checked against the warehouse.`;
  }
  return `Every erasure is clean in the warehouse. ${plural(summary.entries, "entry", "entries")} checked.`;
}

/**
 * How long one entry has been waiting, said once per row (#1961).
 *
 * A row on a compliance queue whose only date is a timestamp makes every reader
 * do the subtraction, and the number they are subtracting toward is a deadline
 * nobody has written down. The elapsed days are the fact; what it is elapsed
 * FROM is stated once at the top of the page rather than on every row, because
 * an explanation attached to the row template becomes a wall of identical text
 * at the real row count (L579).
 */
export function entryAgeText(days: number | null): string {
  if (days === null) return "Erased at a time Slate cannot read.";
  if (days === 0) return "Erased here today.";
  return `Erased here ${plural(days, "day")} ago.`;
}

/**
 * What the elapsed days on this page mean, said ONCE (#1961).
 *
 * The honest and uncomfortable part is the second sentence. Pennie's stated
 * position is a 45 day response deadline running from the person's REQUEST, and
 * the only date the erasure trail holds is when the Supabase half ran, which is
 * necessarily later. A due date computed from what is here would be later than
 * the real one, which is the single direction a compliance clock must never be
 * wrong in, so none is shown and the shortfall is named instead (L589, L11).
 */
export function deadlineNote(): string {
  return `Pennie's stated deadline is ${ERASURE_RESPONSE_DAYS} days to answer a verified deletion request, and it runs from the day the person asked. Slate does not record that day: the only date here is when the Supabase half of the erasure ran, which is later. So the days below are a floor on how long each request has been open, not the whole of it, and no due date is shown because any date computed from this side would fall after the real one.`;
}

/** The empty trail, which is a healthy measured state, not a failure. */
export function emptyTrailText(): string {
  return "No erasure has been recorded yet, so there is nothing to purge. Entries appear here as soon as the Supabase half of a request has run.";
}

export function entryStatusLabel(status: EntryStatus): string {
  if (status === "outstanding") return "Needs a purge";
  if (status === "unknown") return "Not measured";
  return "Clean in the warehouse";
}

/** What the warehouse currently holds for one entry, or why we cannot say. */
export function entryResidualText(entry: ErasureWorklistEntry): string {
  if (entry.residuals === null) {
    // Deliberately not the status pill's own wording: the pill says WHAT the
    // state is, this line says why, and repeating "not measured" twice in a row
    // costs a reader a line and tells them nothing new.
    return `The warehouse could not be asked: ${entry.unmeasuredReason ?? "it did not answer"}.`;
  }
  const dirty = entry.residuals.filter((r) => r.residual > 0);
  if (dirty.length === 0) {
    return "The warehouse holds no contact data for these bookings.";
  }
  return `Still holding contact data: ${dirty
    .map((r) => `${r.table} ${plural(r.residual, "row")}`)
    .join(", ")}.`;
}









export interface PurgeSuccessFacts {
  bookingIds: string[];
  rowsByTable: Record<string, number>;
}



/** The trail read failed, so the list below is not a picture of anything. */
/**
 * How an outstanding purge is actually run, now that no control here runs one
 * (#1961).
 *
 * The page names a fault, so it has to name the remedy, or the reader is left
 * facing a row that says something is owed and a screen with nothing to press,
 * which teaches them to stop reading the page (L126, L148). That the remedy is a
 * person rather than a button is the decision, not an omission, so it says so.
 *
 * It names no command and no secret. A runbook step is a thing that changes; a
 * copy string is a thing that does not, and one naming a stale command would be
 * worse than one naming none (L210).
 */
export function howToPurgeText(): string {
  return "There is no button for this, deliberately: blanking a person's contact data in the warehouse cannot be undone, so it is run as a deliberate, audited step rather than a click. Ask Claude to run the warehouse purge for the entry above, naming who asked for the erasure. It refuses to run without that name, so the audit trail cannot hold a deletion with nobody attached to it. The steps are in docs/pii-erasure-runbook.md.";
}

export function trailUnreadableText(reason: string): string {
  return `The erasure trail could not be read: ${reason}. Until that read works this page cannot tell you what is outstanding, so treat it as unknown rather than clear.`;
}

/** The trail read fine, the warehouse did not answer. */
export function warehouseUnreadableText(reason: string): string {
  return `The warehouse residual could not be measured: ${reason}. The erasures below are listed, but whether Snowflake still holds their contact data is unknown.`;
}

/** No mirror configured here, so there is nothing to measure and nothing to purge. */
export function warehouseUnconfiguredText(): string {
  return "The Snowflake mirror is not configured in this environment, so no residual can be measured and a purge would have nothing to run against.";
}
