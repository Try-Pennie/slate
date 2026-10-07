import { readEnqueueAnswer, type EnqueueAnswer } from "../webhooks/enqueue-answer.ts";

/**
 * What `commit_fresh_booking` answers (#3495, migration 0174).
 *
 * `committed`: the booking row as stored, the webhook's deliveries (null when that
 * step failed), each optional step that failed with its reason (`busy`, `webhook`,
 * `routing`), and whether the reservation was deleted, which it is unless the webhook
 * failed, so the drain re-runs the side effects and the webhook is not lost.
 *
 * `conflict`: the insert met a clash (another booking at the slot, an overlap, a
 * reroute hold, or the lead's own key) and NOTHING was written; `winner` is the active
 * booking holding the lead's idempotency key, or null when the slot went to somebody
 * else.
 *
 * Imports only the enqueue reader, which imports nothing, so the real database suite
 * reads an answer with the same reader the Worker uses on bare node.
 */
export type CommitAnswer =
  | {
      status: "committed";
      booking: CommittedBooking;
      enqueue: EnqueueAnswer | null;
      failed: Record<string, string>;
      reservationDeleted: boolean;
    }
  | { status: "conflict"; winner: CommittedBooking | null };

/** A bookings row as the function returns it (`to_jsonb`), every column present. */
export type CommittedBooking = Record<string, unknown> & {
  id: string;
  org_id: string;
  status: string;
  starts_at: string;
  ends_at: string;
  manage_token: string;
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The answer, or a refusal naming what could not be read. Never a guess: reading an
 * unreadable answer as "conflict" tells a lead to pick another time for a booking
 * that exists, and reading it as "committed" tells them they have one they do not
 * (L11, L505).
 */
export function readCommitAnswer(data: unknown, knownFormats: readonly string[]): CommitAnswer {
  if (!isObject(data)) throw new Error("the booking commit answer was not an object");
  if (data.status === "conflict") {
    return { status: "conflict", winner: data.winner === null ? null : readBooking(data.winner, "winner") };
  }
  if (data.status !== "committed") throw new Error(`the booking commit answer's status was not one this knows: ${JSON.stringify(data.status)}`);
  const booking = readBooking(data.booking, "booking");
  if (!isObject(data.failed) || !Object.values(data.failed).every((v) => typeof v === "string")) {
    throw new Error("the booking commit answer's failed map was not reasons by step");
  }
  const failed = data.failed as Record<string, string>;
  if (typeof data.reservation_deleted !== "boolean") throw new Error("the booking commit answer did not say whether the reservation was deleted");
  // The deliveries exist exactly when the webhook step did not fail.
  if (Object.hasOwn(failed, "webhook") !== (data.enqueue === null)) {
    throw new Error("the booking commit answer's webhook step and its deliveries disagree");
  }
  const enqueue = data.enqueue === null ? null : readEnqueueAnswer(data.enqueue, knownFormats);
  return { status: "committed", booking, enqueue, failed, reservationDeleted: data.reservation_deleted };
}

function readBooking(raw: unknown, what: string): CommittedBooking {
  if (!isObject(raw)) throw new Error(`the booking commit answer's ${what} was not a row`);
  for (const field of ["id", "org_id", "status", "starts_at", "ends_at", "manage_token"] as const) {
    if (typeof raw[field] !== "string" || raw[field] === "") throw new Error(`the booking commit answer's ${what} has no ${field}`);
  }
  return raw as CommittedBooking;
}
