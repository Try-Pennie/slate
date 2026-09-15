import { isHandoffKind, type HandoffInput, type HandoffKind } from "@/lib/handoffs/kinds";

/**
 * Record that a booking is waiting on a person (#2367).
 *
 * Safe to call twice, and meant to be: the writers (#2369, #2370) sit behind HTTP
 * endpoints a journey retries, so the same refusal arrives more than once. The
 * guarantee lives in the database, as `unique (booking_id, kind)`, not in a read
 * before the write, because two concurrent callers can both pass a read. A second
 * call is `already-recorded`: never a second row, never an error.
 *
 * A second call is a no-op even when the first row has since been RESOLVED. The
 * table holds one row per booking and kind, so a situation that ends and then
 * genuinely recurs on the same booking is not recorded again. That is the stated
 * cost of the constraint: in practice both kinds resolve on a booking starting or
 * leaving the active set, neither of which can be undone.
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
   * Insert the row unless one already exists for its (booking_id, kind).
   * `inserted: false` means one was already there. Throws on any other failure.
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
