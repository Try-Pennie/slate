// A model of `commit_fresh_booking` (migration 0174) for the booking fakes (#3495).
//
// The real function does a fresh booking's save in one transaction; what it does in
// the database is proved in a real Postgres by scripts/verify-commit-fresh-booking-sql.ts.
// The fakes model it over the separate steps they already carry (the insert, the busy
// block, the webhook, the routing record, the reservation's delete), so every suite
// that makes the insert race, fail or wait, or reads what the webhook and routing
// record were given, keeps driving exactly that, now through the one call. What the
// model keeps is the contract the verify suite pins:
//
//  - a clash writes nothing else and names the lead's own earlier booking, if any;
//  - a failure the database answered wrote nothing (CommitRefusedError), while a
//    deadline is a call with no answer, which may have committed;
//  - the busy block, the webhook and the routing record each fail on their own,
//    named, without undoing the booking;
//  - the webhook carries the row's own id and times;
//  - the reservation is deleted unless the webhook failed.
//
// It imports only from src/, so a src test can use it without pulling in the scripts
// tree (the reason src/lib/booking/manage-phone-lookup.test.ts gives for not importing
// booking-fakes.ts).
import { CommitRefusedError, type BookingDeps, type CommitFreshInput, type CommitFreshResult } from "../../src/lib/booking/orchestration.ts";
import { isDeadlineExceeded } from "../../src/lib/fetch-within-deadline.ts";
import type { Booking, BookingInsert } from "../../src/lib/db/types.ts";

/** The separate insert the fakes keep, so a suite can make the save race, fail or wait. */
export type FakeInsertResult =
  | { ok: true; booking: Booking }
  | { ok: false; conflict: true }
  | { ok: false; conflict: false; error: unknown };

/** The steps the model is built from: the fake's own, read off the deps it is called on. */
export interface CommitFreshParts {
  insertBooking(row: BookingInsert & { id: string }): Promise<FakeInsertResult>;
  findBookingByIdempotencyKey: BookingDeps["findBookingByIdempotencyKey"];
  moveBusyBlock: BookingDeps["moveBusyBlock"];
  emitWebhook: BookingDeps["emitWebhook"];
  recordRoutingDecision: BookingDeps["recordRoutingDecision"];
  deleteReservation: BookingDeps["deleteReservation"];
  deferSend?: BookingDeps["deferSend"];
}

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function commitFreshModel(parts: CommitFreshParts, input: CommitFreshInput): Promise<CommitFreshResult> {
  const inserted = await parts.insertBooking(input.booking);
  if (!inserted.ok) {
    if (inserted.conflict) {
      const key = input.booking.idempotency_key;
      return { kind: "conflict", winner: key ? await parts.findBookingByIdempotencyKey(key) : null };
    }
    // A deadline is a call with no answer, which the confirm reads back; any other
    // failure is the database answering, which wrote nothing.
    if (isDeadlineExceeded(inserted.error)) throw new Error("the booking commit got no answer", { cause: inserted.error });
    throw new CommitRefusedError({ message: reason(inserted.error) });
  }
  const booking = inserted.booking;
  const failed: { busy?: string; webhook?: string; routing?: string } = {};
  if (booking.assigned_user_id) {
    try {
      await parts.moveBusyBlock(booking.assigned_user_id, booking.starts_at, booking.ends_at, booking.id);
    } catch (err) {
      failed.busy = reason(err);
    }
  }
  try {
    await parts.emitWebhook(
      booking.org_id,
      "booking.created",
      { ...input.webhook.payload, booking_id: booking.id, starts_at: booking.starts_at, ends_at: booking.ends_at },
      input.webhook.dedupeKey,
      input.webhook.suppressed,
      parts.deferSend,
    );
  } catch (err) {
    failed.webhook = reason(err);
  }
  if (input.routing) {
    try {
      await parts.recordRoutingDecision(input.routing);
    } catch (err) {
      failed.routing = reason(err);
    }
  }
  let reservationDeleted = false;
  if (failed.webhook === undefined) {
    await parts.deleteReservation(input.reservationId);
    reservationDeleted = true;
  }
  return { kind: "committed", booking, failed, reservationDeleted };
}
