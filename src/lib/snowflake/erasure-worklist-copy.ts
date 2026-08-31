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
  TrailScope,
  WorklistSummary,
} from "./erasure-worklist";
import { entryResidualTotal } from "./erasure-worklist";

const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`;

/** The page's one line answer to "is there anything to do here". */
export function worklistHeadline(summary: WorklistSummary): string {
  // Deliberately not the empty state's own sentence below it: a heading and the
  // paragraph under it saying the same words is a wasted line.
  if (summary.entries === 0) return "Nothing to purge yet.";
  if (summary.outstanding > 0) {
    return `${plural(summary.outstanding, "erasure")} still ${
      summary.outstanding === 1 ? "has" : "have"
    } contact data in the warehouse.`;
  }
  if (summary.unknown > 0) {
    return `${plural(summary.unknown, "erasure")} could not be checked against the warehouse.`;
  }
  return `Every erasure is clean in the warehouse. ${plural(summary.entries, "entry", "entries")} checked.`;
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

/** The narrow control: one erasure's bookings and nothing else. */
export function entryPurgeLabel(): string {
  return "Purge this erasure";
}

export function entryPurgeConfirm(entry: ErasureWorklistEntry): string {
  const total = entryResidualTotal(entry);
  const consequence =
    total === null
      ? "The warehouse could not be checked, so this may or may not change anything."
      : total > 0
        ? `The warehouse holds ${plural(total, "row")} of contact data for them right now.`
        : "The warehouse already reports nothing left for them, so this should change nothing.";
  return `Purge this erasure only: ${plural(entry.bookingIds.length, "booking")}. Nothing outside this erasure is touched. ${consequence}`;
}

/** The wide control: every booking the trail holds, which is the self correcting one. */
export function purgeAllLabel(): string {
  return "Purge every erasure in the trail";
}

export function purgeAllConfirm(trail: TrailScope): string {
  const base = `Purge every booking in the erasure trail: ${plural(
    trail.entryCount,
    "erasure",
  )}, ${plural(trail.bookingCount, "booking")}. That includes the ones already clean, which is what makes a missed purge fix itself.`;
  if (trail.otherOrgBookingCount > 0) {
    return `${base} ${plural(
      trail.otherOrgBookingCount,
      "booking",
    )} in the trail belong to another org and are not listed above, and this control reaches them too.`;
  }
  return base;
}

/** Started: the round trip is under way, with the elapsed time as proof it is alive. */
export function purgeWorkingText(seconds: number): string {
  return `Purging in the warehouse. ${seconds}s elapsed.`;
}

/** Still alive: longer than usual, but nothing has gone wrong yet. */
export function purgeStalledText(seconds: number): string {
  return `Still going after ${seconds}s. Warehouse statements can take a while. This page will say so if it gives up waiting.`;
}

/**
 * Failed by deadline. It deliberately does not claim the purge failed: we stopped
 * waiting, which is a different fact, and the warehouse may well have finished.
 */
export function purgeTimeoutText(seconds: number): string {
  return `We stopped waiting after ${seconds}s. The purge may have finished in the warehouse anyway, so reload this page to check the residual before you try again.`;
}

/** Failed outright, with the server's own reason. */
export function purgeFailedText(reason: string | null): string {
  if (!reason) {
    return "The purge did not run, and the server gave back no reason. Reload this page to see the current state before trying again.";
  }
  return `The purge did not run: ${reason}`;
}

export interface PurgeSuccessFacts {
  bookingIds: string[];
  rowsByTable: Record<string, number>;
}

/** Succeeded, meaning the verify afterwards measured nothing left. */
export function purgeSucceededText(facts: PurgeSuccessFacts): string {
  const changed = Object.entries(facts.rowsByTable)
    .map(([table, rows]) => `${table} ${plural(rows, "row")}`)
    .join(", ");
  const tail = changed ? ` Rows rewritten: ${changed}.` : "";
  return `Purge finished for ${plural(
    facts.bookingIds.length,
    "booking",
  )}, and the verify afterwards found no contact data left.${tail}`;
}

/**
 * Ran, and left something behind. The route reports this as a 500 with `ok:false`,
 * and it must never read like the success above.
 */
export function purgeLeftResidualText(reasons: string[]): string {
  const detail = reasons.length > 0 ? ` ${reasons.join(" ")}` : "";
  return `The purge ran and the warehouse still holds contact data.${detail}`;
}

/** The trail read failed, so the list below is not a picture of anything. */
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
