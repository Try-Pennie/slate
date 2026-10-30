/**
 * The ONE rule for whether a booking is a program lead's (#4255, #4389).
 *
 * A program lead is a Salesforce Lead registered for the program (`program_leads`,
 * migration 0213). For a NEW booking, the lead needs a live registration: a row whose
 * `expires_at` is still in the future. For a MOVE of an existing booking, the booking's own
 * `program_lead` mark decides, and the registration is not consulted: the mark is written
 * when a program booking is made and carried through every move, so a program booking stays
 * one after the 30 day registration lapses, and a live registration never turns an ordinary
 * booking's move into a program move.
 *
 * Read by the texted booking page and its manage page (#4389), the times shown (#4390) and
 * the booking and the move (#4391), so the times a lead is offered and the booking Slate
 * accepts cannot disagree (L261, L370). Pure: the clock is passed in.
 */
import { parseStampMs } from "../date/stamp.ts";

export interface ProgramLeadQuestion {
  /** The lead's `program_leads` row, or null when it has none. Read for a new booking only. */
  registration?: { expires_at: string } | null;
  /** The booking being MOVED. Present means a move; absent means a new booking. */
  booking?: { program_lead: boolean } | null;
  nowMs: number;
}

export function isProgramLead(q: ProgramLeadQuestion): boolean {
  if (q.booking) return q.booking.program_lead === true;
  if (!q.registration) return false;
  // An expiry that does not parse is never read as live (L50): the harmless side is the
  // ordinary booker.
  const expiresMs = parseStampMs(q.registration.expires_at);
  return expiresMs !== null && expiresMs > q.nowMs;
}
