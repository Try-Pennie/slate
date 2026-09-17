/**
 * The ONE place a gated booking write is classified (#2373).
 *
 * A gated write is an UPDATE narrowed by the state it expects to find, returning
 * the rows it actually transitioned:
 *
 *   update({ status: "cancelled" }).eq("id", id).in("status", ACTIVE).select("id")
 *
 * Exactly one caller wins that statement, which is what makes cancel, reschedule,
 * completion, the reservation lease and the delivery attempt claim safe to run
 * twice. The rows it returns are the whole answer: rows means this call made the
 * transition, no rows means somebody else already had.
 *
 * ## The defect
 *
 * Every one of those sites read only `data` and returned `data.length > 0`.
 * supabase-js does not throw on a statement Postgres refuses: it resolves
 * `{ data: null, error }`, and a null `data` is `length === 0`. So a write that
 * NEVER RAN was reported as a lost race, and the two mean opposite things:
 *
 *   - a LOST RACE is the system working. Somebody else got there first, the state
 *     the caller wanted is already true, and nobody needs to be told anything is
 *     wrong.
 *   - a FAILED WRITE is the system not working. Nothing changed, the lead can do
 *     nothing about it, and somebody should hear about it.
 *
 * On the cancel path that conflation reached a customer: `claimCancellation`
 * returned false, `cancelBooking` discarded the flag, the route answered
 * `{ ok: true }`, and the lead read "Your call is cancelled" while the booking,
 * the Google invite and the advisor's slot all stood (L12, L215, L260).
 *
 * ## The rule
 *
 * Classify once, here, and let every reader branch on the CLASSIFICATION rather
 * than re-derive it from an error string (L35). `classifyGatedWrite` is the pure
 * judge; `gatedWriteRows` is the one line a call site writes; and
 * `isBookingWriteFailure` is how a route tells the two apart. Nothing else may
 * decide it, which is why the raw database reason lives on the error rather than
 * in its message: a caller matching on wording would be a second classifier.
 *
 * What each cause produces is decided by the reader, not here, because it differs
 * per surface: a lost cancel claim is a truthful `{ ok: true }`, a lost reschedule
 * commit is a 409 that tells the lead their booking moved, and a lost completion
 * claim is simply one fewer webhook to fire. A failed write is a 503 on every one
 * of them, and it is reported through the internal-error chokepoint so it pages.
 *
 * No `@/` imports beyond the copy builder, which has none of its own, so scripts
 * can drive this node-natively.
 */
import { BOOKING_ERROR_COPY } from "@/lib/booking/booker-copy";

/**
 * The two ways a gated write can end without having applied, as ONE list, so a
 * reader enumerating them cannot miss one and a third cannot be added silently.
 */
export const GATED_WRITE_CAUSES = ["lost_race", "write_failed"] as const;

export type GatedWriteCause = (typeof GATED_WRITE_CAUSES)[number];

/**
 * Which gated write this is. Named rather than free text so a log line and an
 * alert say which statement failed, and so `tsc` enumerates the sites the day a
 * seventh is added.
 */
export type GatedWriteOp =
  /** Flip a booking active to cancelled (#413). */
  | "cancel_claim"
  /** Apply a reschedule only while the booking is still the one we started moving (#615). */
  | "reschedule_commit"
  /** Batch flip finished bookings to completed (#163, #164). */
  | "complete_due"
  /** Take the drain lease on a booking reservation (#445). */
  | "reservation_lease"
  /** Take the per-calendar sync claim so two ticks do not sync one calendar (#273). */
  | "calendar_sync_claim"
  /** Compare and swap a webhook delivery's attempt counter (#623). */
  | "webhook_attempt_claim";

/** What one gated write turned out to be. */
export type GatedWriteVerdict<Row> =
  /** THIS statement transitioned these rows. */
  | { cause: "applied"; rows: Row[] }
  /** It ran and touched nothing: somebody else got there first. */
  | { cause: "lost_race" }
  /**
   * It did not run. `reason` is the database's own text, for the LOG: it never
   * reaches a lead, because an alert or a screen carrying a raw error body is the
   * #1133 defect and a reader mid-incident cannot act on it.
   */
  | { cause: "write_failed"; reason: string };

/** The shape supabase-js resolves for an update returning its rows. */
export interface GatedWriteResult<Row> {
  data: Row[] | null;
  error: { message: string } | null;
}

/**
 * Judge one gated write. Pure, so every branch is drivable with no database.
 *
 * A null `data` with NO error is treated as a lost race, not a failure: it is the
 * same nothing-happened the empty array means, and scoring it as a failure would
 * page on the ordinary case.
 */
export function classifyGatedWrite<Row>(result: GatedWriteResult<Row>): GatedWriteVerdict<Row> {
  if (result.error) return { cause: "write_failed", reason: result.error.message };
  const rows = result.data ?? [];
  return rows.length > 0 ? { cause: "applied", rows } : { cause: "lost_race" };
}

/**
 * A gated booking write that did not run.
 *
 * Its MESSAGE is the lead's sentence, from the copy builder, so the routes can
 * hand it straight back and `pnpm preview:booker` renders exactly what ships
 * (L41). Its `reason` is the database's own text and stays out of that message.
 */
export class BookingWriteFailedError extends Error {
  readonly op: GatedWriteOp;
  /** The database's own text, for the log line and the page. Never for a lead. */
  readonly reason: string;

  constructor(op: GatedWriteOp, reason: string) {
    super(BOOKING_ERROR_COPY.writeFailed);
    this.name = "BookingWriteFailedError";
    this.op = op;
    this.reason = reason;
  }
}

/** The one predicate a reader branches on. Never a match on wording (L35). */
export function isBookingWriteFailure(err: unknown): err is BookingWriteFailedError {
  return err instanceof BookingWriteFailedError;
}

/**
 * The rows a gated write transitioned, or `null` when it lost the race.
 *
 * Throws `BookingWriteFailedError` when the statement did not run, which is the
 * whole point: a caller that cannot tell the two apart cannot be trusted to say
 * what happened, so the failure leaves through a path that cannot be mistaken for
 * a no-op.
 */
export function gatedWriteRows<Row>(
  op: GatedWriteOp,
  result: GatedWriteResult<Row>,
): Row[] | null {
  const verdict = classifyGatedWrite(result);
  if (verdict.cause === "write_failed") throw new BookingWriteFailedError(op, verdict.reason);
  return verdict.cause === "applied" ? verdict.rows : null;
}

/** The boolean form, for a gated write whose answer is "did I win it". */
export function gatedWriteApplied<Row>(
  op: GatedWriteOp,
  result: GatedWriteResult<Row>,
): boolean {
  return gatedWriteRows(op, result) !== null;
}
