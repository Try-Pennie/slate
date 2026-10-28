// #3616: the decisions behind `scripts/verify-marcia-rebook-live.ts`, kept pure and pinned by
// `scripts/test-marcia-rebook-check.ts`, so a live run is spent only on what no fixture can
// answer: the deployed booking MCP booking a time, cancelling it, and booking the SAME time
// again, each booking with its own Google Calendar event.
import { MACHINE_TOKEN_AUDIENCE, MACHINE_TOKEN_ISSUER } from "../../src/lib/mcp-booking/token-shape.ts";
import { PARTNER_BUCKET_CODE } from "../../src/lib/embed/public-test-bucket.ts";
import { MARCIA_SETUP_OUTCOMES, RUN_TIME_ZONE } from "./marcia-lead-fill-check.ts";

/** Every way a run can end, each on its own exit code (L11). */
export const REBOOK_OUTCOMES = {
  ...MARCIA_SETUP_OUTCOMES,
  proven: { exit: 0, says: "the booking MCP booked a time, cancelled it, and booked the same time again on production, each booking with its own calendar event, and both test calls are cancelled" },
  leadUnsuitable: { exit: 3, says: "this Salesforce Lead cannot be booked by the run (it needs an email at a Pennie address and a phone); nothing was booked" },
  leadHoldsCall: { exit: 4, says: "the lead already holds a test call, so a book would land on it rather than make a new one; nothing was booked" },
  noTimes: { exit: 6, says: "find_times through the booking MCP offered no time on the partner test bucket; nothing was booked" },
  mcpRefused: { exit: 7, says: "the booking MCP refused the first book or a cancel" },
  rebookRefused: { exit: 8, says: "after the cancel, the booking MCP refused to book the same time again" },
  notProven: { exit: 9, says: "every call was answered, but a booking or its calendar event is not what the answer said" },
  residue: { exit: 10, says: "cleanup left a test call active" },
  cleanupUnverified: { exit: 11, says: "cleanup could not read whether a test call is cancelled, so nothing is vouched for" },
  slateUnreadable: { exit: 12, says: "Slate's bookings for the lead could not be read; nothing was booked" },
  rowUnreadable: { exit: 13, says: "a booking or its calendar event could not be read back, so the step is unmeasured" },
  unexpected: { exit: 14, says: "the run itself failed in a way no step expected, named" },
} as const;
export type RebookOutcome = keyof typeof REBOOK_OUTCOMES;

/**
 * The claims of one test token: test flagged, so Slate books the partner test bucket and
 * sends no webhook; carrying the lead's name, email and phone, because a book through
 * Marcia that makes a NEW call needs all three on the token, and the second book is new
 * again once the first is cancelled. One per call, each with its own nonce.
 */
export function rebookClaims(leadId: string, nowMs: number, nonce: string, contact: { name: string; email: string; phone: string }): Record<string, unknown> {
  const iat = Math.floor(nowMs / 1000);
  return {
    iss: MACHINE_TOKEN_ISSUER,
    aud: MACHINE_TOKEN_AUDIENCE,
    iat,
    exp: iat + 10 * 60,
    nonce,
    salesforce_id: leadId,
    bucket_code: PARTNER_BUCKET_CODE,
    name: contact.name,
    email: contact.email,
    phone: contact.phone,
    time_zone: RUN_TIME_ZONE,
    test: true,
  };
}

/** A nonce no earlier run used: the run's start and the call's number. */
export function rebookNonce(runStartedMs: number, n: number): string {
  return `rebook-check-${runStartedMs}-${n}`;
}

/** What one step can be judged on: the MCP's answer, the booking row, and the advisor's calendar. */
export interface CallFacts {
  answer: { outcome: string; booking_id: string; starts_at: string } | null;
  row: { id: string; status: string; starts_at: string; gcal_event_id: string | null; agent_email: string | null } | null;
  /** The event as Google holds it on the advisor's primary calendar; null when Google has none. */
  event: { status?: string } | null;
}

export type Verdict = { ok: true } | { ok: false; why: string };

const sameInstant = (a: string, b: string) => Date.parse(a) === Date.parse(b);

/** The row read must be the booking the answer named, or nothing about it is evidence. */
function rowMismatch(bookingId: string, row: CallFacts["row"]): { ok: false; why: string } | null {
  return !row || row.id !== bookingId ? { ok: false, why: `the row read is not booking ${bookingId}` } : null;
}

/** A book that made a NEW call: created, the row confirmed, and a live event on the calendar. */
export function bookVerdict(f: CallFacts): Verdict {
  if (f.answer?.outcome !== "created") return { ok: false, why: `the book answered ${String(f.answer?.outcome)}, not created` };
  const wrongRow = rowMismatch(f.answer.booking_id, f.row);
  if (wrongRow) return wrongRow;
  if (f.row.status !== "confirmed") return { ok: false, why: `booking ${f.row.id} is ${f.row.status}, not confirmed` };
  if (!f.row.gcal_event_id) return { ok: false, why: `booking ${f.row.id} carries no calendar event id` };
  if (!f.event) return { ok: false, why: `Google holds no event ${f.row.gcal_event_id} for booking ${f.row.id}` };
  if (f.event.status === "cancelled") return { ok: false, why: `event ${f.row.gcal_event_id} for booking ${f.row.id} is cancelled in Google` };
  return { ok: true };
}

/** A cancel that freed the time: cancelled by THIS call, the row cancelled, the event gone. */
export function cancelVerdict(f: CallFacts): Verdict {
  if (f.answer?.outcome !== "cancelled") return { ok: false, why: `the cancel answered ${String(f.answer?.outcome)}, not cancelled` };
  const wrongRow = rowMismatch(f.answer.booking_id, f.row);
  if (wrongRow) return wrongRow;
  if (f.row.status !== "cancelled") return { ok: false, why: `booking ${f.row.id} is ${f.row.status} after the cancel` };
  // Google keeps a deleted event readable with status cancelled; either reading frees the time.
  if (f.event && f.event.status !== "cancelled") return { ok: false, why: `event ${String(f.row.gcal_event_id)} is still live in Google after the cancel` };
  return { ok: true };
}

/** The rebook: the SAME start, a different booking, its own calendar event. */
export function sameSlotVerdict(first: CallFacts, second: CallFacts): Verdict {
  if (!first.row || !second.row) return { ok: false, why: "a booking row is missing" };
  if (!sameInstant(first.row.starts_at, second.row.starts_at)) return { ok: false, why: `the rebook starts at ${second.row.starts_at}, not ${first.row.starts_at}` };
  if (first.row.id === second.row.id) return { ok: false, why: `the rebook brought back booking ${first.row.id} rather than making a new one` };
  if (!second.row.gcal_event_id || second.row.gcal_event_id === first.row.gcal_event_id) {
    return { ok: false, why: "the rebook does not carry its own calendar event" };
  }
  return { ok: true };
}

type CleanupProblem = { outcome: "residue" | "cleanupUnverified"; detail: string };

/**
 * How a run ends once cleanup has been judged. A cleanup problem wins the exit code,
 * because a call left on a calendar is the urgent thing, a known leftover ahead of an
 * unread one, but the run's own result is kept in the message, so both are said.
 */
export function rebookFinalOutcome(run: { outcome: RebookOutcome; detail?: string }, cleanup: CleanupProblem[]): { outcome: RebookOutcome; detail?: string } {
  if (cleanup.length === 0) return run;
  const lead = cleanup.find((c) => c.outcome === "residue") ?? cleanup[0]!;
  const before = `${run.outcome === "proven" ? "before cleanup the run had proven the rebook" : `before cleanup the run had failed: ${REBOOK_OUTCOMES[run.outcome].says}`}${run.detail ? ` (${run.detail})` : ""}`;
  return { outcome: lead.outcome, detail: `${cleanup.map((c) => c.detail).join("; ")}; ${before}` };
}
