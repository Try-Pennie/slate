import { isJsonObject } from "../webhooks/enqueue-answer.ts";

/**
 * One row of what `find_active_bookings_for_person` answers (#3476, migration 0175): a
 * bookings row as `to_jsonb` renders it, with its bucket's world lifted to `isTest`.
 */
export type PersonBookingRow = Record<string, unknown> & { id: string; status: string; isTest: boolean };

/**
 * The lead's active bookings, or a refusal naming what could not be read. Never a
 * guess, and never an empty list for an answer it could not read: empty is the
 * specific answer "this lead has no call booked", which lets a second booking be made
 * for somebody who already has one (#1641).
 *
 * Imports only the enqueue reader's object check, which imports nothing, so the real
 * database suite reads the answer with the same reader the Worker uses, on bare node.
 */
export function readPersonBookings(data: unknown): PersonBookingRow[] {
  if (!Array.isArray(data)) throw new Error("the person booking lookup's answer was not a list");
  const seen = new Set<string>();
  return data.map((raw, i) => {
    if (!isJsonObject(raw)) throw new Error(`the person booking lookup's row ${i} was not a row`);
    const { is_test: isTest, ...row } = raw;
    if (typeof row.id !== "string" || row.id === "") throw new Error(`the person booking lookup's row ${i} has no id`);
    if (typeof row.status !== "string" || row.status === "") throw new Error(`the person booking lookup's row ${i} has no status`);
    if (typeof isTest !== "boolean") throw new Error(`the person booking lookup's row ${i} does not say which world it is in`);
    if (seen.has(row.id)) throw new Error(`the person booking lookup answered booking ${row.id} twice`);
    seen.add(row.id);
    return { ...row, id: row.id, status: row.status, isTest };
  });
}
