import { isHandoffKind, type HandoffInput, type HandoffKind } from "@/lib/handoffs/kinds";

/**
 * Record that a booking is waiting on a person (#2367).
 *
 * Safe to call twice, and meant to be: the writers (#2369, #2370) sit behind HTTP
 * endpoints a journey retries, so the same refusal arrives more than once. The
 * guarantee lives in the database, as a partial unique index on (booking_id, kind)
 * over OPEN rows, not in a read before the write, because two concurrent callers can
 * both pass a read. A second call while a row is open is `already-recorded`: never a
 * second open row, never an error.
 *
 * Once that row has been RESOLVED, the same booking and kind can be recorded again,
 * and is: a situation that ends and then genuinely recurs needs a person again, and
 * the resolved row stays as history beside the new open one.
 *
 * A real write error THROWS with its own message. Swallowing it would leave a
 * situation that needs a person recorded nowhere while the caller answered as if it
 * had been handed over, which is the silence this table exists to end.
 */

/** The row a writer inserts. Every other column takes its database default. */
export interface NewHandoffRow {
  booking_id: string;
  kind: HandoffKind;
  detail: Record<string, unknown>;
}

/** The one write this needs, so the rule is testable without a database. */
export interface HandoffWriter {
  /**
   * Insert the row unless an OPEN one already exists for its (booking_id, kind).
   * `inserted: false` means one was already open. Throws on any other failure.
   */
  insertOnce: (row: NewHandoffRow) => Promise<{ inserted: boolean }>;
}

export type RecordHandoffOutcome = "recorded" | "already-recorded";

export async function recordHandoff(
  writer: HandoffWriter,
  input: HandoffInput,
): Promise<RecordHandoffOutcome> {
  const bookingId = input.bookingId.trim();
  if (!bookingId) throw new Error("recordHandoff: a handoff needs a booking id");
  if (!isHandoffKind(input.kind)) {
    throw new Error(`recordHandoff: ${String(input.kind)} is not a handoff kind`);
  }
  const { inserted } = await writer.insertOnce({
    booking_id: bookingId,
    kind: input.kind,
    detail: { ...input.detail },
  });
  return inserted ? "recorded" : "already-recorded";
}
