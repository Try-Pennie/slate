import { programLeadTokenSecret } from "@/lib/env";
import { log } from "@/lib/log";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { parseStampMs } from "@/lib/date/stamp";
import { isLeadId } from "@/lib/salesforce/lead-id";
import { leadIdKey } from "@/lib/salesforce/lead-xbc";
import type { Booking } from "@/lib/db/types";
import { isProgramLead } from "./program-lead";
import {
  mintProgramLeadToken,
  readProgramLeadToken,
  readProgramLeadTokenAsIssued,
  type ProgramLeadFacts,
} from "./program-lead-token";

/**
 * The server half of the program lead token (#4389): the one place that reads the secret,
 * the clock and `program_leads` to mint one, and the one check the routes run on one.
 *
 * `program_leads` is read ONLY by `programLeadTokenForLanding`, which the texted booking
 * page calls with the id its throttled per person lookup (`landingLookupId`, #3106, #3173)
 * allowed. No route a stranger can call with an id of their choosing reads it: the times,
 * booking and move routes (#4390, #4391) call `verifyProgramLeadToken` instead.
 */

/** A Lead's registration, or null when it has none. THROWS on a failed read, so a
 *  failure can never read as "not registered" to anything that asks it directly. */
export async function loadProgramLeadRegistration(salesforceId: string): Promise<{ expires_at: string } | null> {
  return unwrap(
    await supabaseAdmin()
      .from("program_leads")
      .select("expires_at")
      .eq("lead_key", leadIdKey(salesforceId))
      .maybeSingle(),
    "program_leads registration",
  );
}

/**
 * The token for a NEW booking by the lead the texted link names, or null when they are not
 * a program lead. `lookupId` must be the throttled one: an empty id (no id, or over the per
 * address ceiling) reads nothing. Never throws: a failed read is logged and the lead gets
 * the ordinary booker, which is the harmless side (they are shown real times only).
 */
export async function programLeadTokenForLanding(lookupId: string): Promise<string | null> {
  if (!lookupId || !isLeadId(lookupId)) return null;
  let registration: { expires_at: string } | null;
  try {
    registration = await loadProgramLeadRegistration(lookupId);
  } catch (err) {
    log.warn("program-lead", { msg: "registration read failed, showing the ordinary booker" }, err);
    return null;
  }
  const nowMs = Date.now();
  if (!isProgramLead({ registration, nowMs })) return null;
  const secret = programLeadTokenSecret();
  if (!secret) {
    log.error("program-lead", {
      msg: "a registered program lead got the ordinary booker: PROGRAM_LEAD_TOKEN_SECRET is unset",
    });
    return null;
  }
  // A live registration's expiry parses, or isProgramLead would have said no.
  const notAfterMs = parseStampMs(registration?.expires_at) ?? undefined;
  return mintProgramLeadToken({ salesforceId: lookupId, bookingId: null, secret, nowMs, notAfterMs }).value;
}

/**
 * The token for MOVING `booking`, or null when it is not a program booking. The manage
 * token already identifies the viewer, so this reads nothing: the booking's own mark is the
 * whole answer (`isProgramLead` for a move). Never throws.
 */
export function programLeadMoveTokenFor(booking: Pick<Booking, "id" | "program_lead" | "salesforce_id">): string | null {
  if (!isProgramLead({ booking, nowMs: Date.now() })) return null;
  if (!booking.salesforce_id || !isLeadId(booking.salesforce_id)) {
    log.warn("program-lead", { msg: "a program booking carries no Lead id, so it moves as an ordinary one", booking_id: booking.id });
    return null;
  }
  const secret = programLeadTokenSecret();
  if (!secret) {
    log.error("program-lead", {
      msg: "a program booking's move is ordinary: PROGRAM_LEAD_TOKEN_SECRET is unset",
      booking_id: booking.id,
    });
    return null;
  }
  return mintProgramLeadToken({ salesforceId: booking.salesforce_id, bookingId: booking.id, secret, nowMs: Date.now() }).value;
}

/**
 * The check the times, booking and move routes run (#4390, #4391): the facts a presented
 * token establishes for the lead and booking the REQUEST names, or null. Null is "not a
 * program lead", never an error: no token is an ordinary lead and says nothing; a refused
 * one is logged by its reason class, never the token itself, which is a credential for as
 * long as it lives.
 */
export function verifyProgramLeadToken(
  token: string | null | undefined,
  ask: { salesforceId: string; bookingId?: string | null },
): ProgramLeadFacts | null {
  if (!token) return null;
  const reading = readProgramLeadToken(token, {
    salesforceId: ask.salesforceId,
    bookingId: ask.bookingId ?? null,
    secret: programLeadTokenSecret(),
    nowMs: Date.now(),
  });
  if (reading.ok) return reading.facts;
  log.warn("program-lead", { msg: "refused a program lead token", reason: reading.reason });
  return null;
}

/**
 * The check the times read runs (#4390): the token judged as issued
 * (`readProgramLeadTokenAsIssued`), because a times request names no lead and no booking
 * of its own. A good token unlocks only the extra times on screen; the booking and the
 * move check theirs against the lead and booking they act on (`verifyProgramLeadToken`).
 * The refusal comes back by its reason so the caller can COUNT `secret-unset`, which is a
 * failed read rather than a stranger's token. Logged by reason, never the token. Never throws.
 */
export function readProgramLeadTimesToken(token: string): ReturnType<typeof readProgramLeadTokenAsIssued> {
  const reading = readProgramLeadTokenAsIssued(token, { secret: programLeadTokenSecret(), nowMs: Date.now() });
  if (!reading.ok) log.warn("program-lead", { msg: "refused a program lead token on the times read", reason: reading.reason });
  return reading;
}
