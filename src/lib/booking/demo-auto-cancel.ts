import type { ValidatedReason } from "./core.ts";

/**
 * Demo bookings cancel themselves (#3424).
 *
 * The demo page (`/demo`) lets somebody outside Pennie book a real call on the
 * test agent's calendar. Dan, 2026-10-06: cancel it 30 minutes after it is made,
 * long enough to open the manage page and try a reschedule, and short enough that
 * a link passed around cannot fill the test agent's day.
 *
 * The cancel goes through the ordinary cancel path (`service.cancelBooking`), so
 * the calendar event, the busy block and the history row are handled exactly as a
 * visitor's own cancel would be, and the demo bucket being a test bucket keeps the
 * webhook suppressed at the choke point.
 *
 * Fails loud. A cancel that throws does not stop the rest of the batch, and the
 * sweep then throws `DemoAutoCancelError`, which the complete lane counts toward
 * its failing sweep streak, so a sweep that cannot cancel pages rather than
 * leaving demo calls to pile up behind a lane answering 200.
 *
 * Pure apart from its deps: the clock is passed in.
 */

/** How long a demo booking lives, measured from when it was made. */
export const DEMO_AUTO_CANCEL_AFTER_MS = 30 * 60_000;

/** Bookings cancelled per run. Each cancel is a calendar delete and a few writes on
 *  a lane whose subrequests are shared, and the complete lane runs every 5 minutes,
 *  so ten a run is far more than a demo is ever booked. */
export const DEMO_AUTO_CANCEL_BATCH = 10;

/** Recorded on the cancel's history row. Not a reason a lead can choose. */
export const DEMO_AUTO_CANCEL_REASON: ValidatedReason = { code: "demo_auto_cancel", detail: null };

export interface DemoAutoCancelDeps {
  /** Active demo bookings made at or before `cutoffIso`, oldest first, at most
   *  `limit`. Throws on a failed read. */
  listDue(cutoffIso: string, limit: number): Promise<{ id: string; manageToken: string }[]>;
  /** Cancel one by its manage token: true when this call made the transition,
   *  false when somebody else cancelled it first. */
  cancel(manageToken: string): Promise<boolean>;
  /** Record why one booking's cancel failed, with the error itself, so the log
   *  says whether Google, the database or something else refused it. Must not
   *  throw. */
  reportFailure(bookingId: string, err: unknown): void;
}

export interface DemoAutoCancelResult {
  cancelled: number;
  /** Cancelled by somebody else between the read and the cancel, usually the
   *  visitor trying the manage page. Not a fault. */
  alreadyGone: number;
  /** A full batch came back, so more may be waiting for the next run. */
  backlogRemains: boolean;
}

/** Some due demo bookings could not be cancelled. Carries ids, never tokens. */
export class DemoAutoCancelError extends Error {
  readonly failedIds: string[];
  readonly cancelled: number;
  constructor(failedIds: string[], cancelled: number) {
    super(`demo auto cancel failed for ${failedIds.length} booking(s): ${failedIds.join(", ")}`);
    this.name = "DemoAutoCancelError";
    this.failedIds = failedIds;
    this.cancelled = cancelled;
  }
}

export async function cancelDueDemoBookings(
  deps: DemoAutoCancelDeps,
  nowMs: number,
): Promise<DemoAutoCancelResult> {
  const cutoffIso = new Date(nowMs - DEMO_AUTO_CANCEL_AFTER_MS).toISOString();
  const due = await deps.listDue(cutoffIso, DEMO_AUTO_CANCEL_BATCH);
  let cancelled = 0;
  let alreadyGone = 0;
  const failedIds: string[] = [];
  for (const b of due) {
    try {
      if (await deps.cancel(b.manageToken)) cancelled++;
      else alreadyGone++;
    } catch (err) {
      failedIds.push(b.id);
      deps.reportFailure(b.id, err);
    }
  }
  if (failedIds.length > 0) throw new DemoAutoCancelError(failedIds, cancelled);
  return { cancelled, alreadyGone, backlogRemains: due.length >= DEMO_AUTO_CANCEL_BATCH };
}
