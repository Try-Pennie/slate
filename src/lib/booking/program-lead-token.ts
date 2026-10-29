/**
 * The short lived token that carries "this lead is a program lead" from the page to the
 * routes (#4389).
 *
 * The texted booking page decides `isProgramLead` on the server, through its throttled per
 * person lookup, and hands the Booker this token. The times, booking and move routes
 * (#4390, #4391) trust ONLY the token and never read `program_leads` for an id they are
 * given, so no public route reveals who is a program lead and a made up id costs nothing
 * extra. A token says one of two things:
 *
 *   - this Lead may make a NEW booking as a program lead (scope `new`), or
 *   - this Lead may MOVE booking X as a program lead (scope: the booking id).
 *
 * Shape: `<lead key>.<scope>.<expires at ms>.<hex HMAC>`, signed by the shared signer
 * (`signed-fields.ts`) under its own context and its own secret, `PROGRAM_LEAD_TOKEN_SECRET`.
 * The lead key is `leadIdKey`, so the 15 and 18 character spellings of one Lead are one lead.
 *
 * Every refusal is "not a program lead" to the caller: the ordinary booker, never an error
 * page. Pure: the secret and the clock are passed in (`scripts/test-program-lead.ts`).
 */
import { leadIdKey } from "../salesforce/lead-xbc.ts";
import { isLeadId } from "../salesforce/lead-id.ts";
import { fieldsSignature, fieldsSignatureMatches } from "../signed-fields.ts";

/**
 * Two hours. A program lead opens the texted link, and may leave the page open while they
 * check their calendar or step away before picking a time; a reload mints a fresh one while
 * they are still a program lead, so the TTL bounds only how long a token copied OUT of a
 * page keeps working. The test pass's 30 minutes (#2666) fits a modal left open; a texted
 * page sits longer, and a lead whose token runs out mid visit is shown real times only,
 * which is the harmless side.
 */
export const PROGRAM_LEAD_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;

/** Domain separation, so this HMAC is never mistaken for another made with any secret. */
const CONTEXT = "slate-program-lead.v1";
const NEW_SCOPE = "new";

export const PROGRAM_LEAD_TOKEN_REFUSALS = [
  "secret-unset",
  "missing",
  "malformed",
  "forged",
  "expired",
  "other-lead",
  "other-booking",
] as const;
export type ProgramLeadTokenRefusal = (typeof PROGRAM_LEAD_TOKEN_REFUSALS)[number];

/** What a good token establishes. */
export interface ProgramLeadFacts {
  /** The Lead's 15 character key. */
  leadKey: string;
  purpose: "new" | "move";
  /** The booking a move token moves; null for a new booking's token. */
  bookingId: string | null;
  expiresAtMs: number;
}

const BOOKING_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Make a token for `salesforceId`, for a new booking (`bookingId` null) or for moving one
 * booking. The caller has already decided, with `isProgramLead`, that the lead deserves it.
 * `notAfterMs` is the registration's own expiry, so a token never outlives the mark it was
 * issued on. Throws on an id that is not a Lead or an empty secret: both are the caller's
 * mistake, never something to sign around.
 */
export function mintProgramLeadToken(input: {
  salesforceId: string;
  bookingId: string | null;
  secret: string;
  nowMs: number;
  notAfterMs?: number;
}): { value: string; expiresAtMs: number } {
  if (!input.secret) throw new Error("mintProgramLeadToken: no secret to sign with");
  if (!isLeadId(input.salesforceId)) throw new Error("mintProgramLeadToken: not a Lead id");
  if (input.bookingId !== null && !BOOKING_ID.test(input.bookingId)) {
    throw new Error("mintProgramLeadToken: not a booking id");
  }
  const leadKey = leadIdKey(input.salesforceId);
  const scope = input.bookingId ?? NEW_SCOPE;
  const expiresAtMs = Math.min(input.nowMs + PROGRAM_LEAD_TOKEN_TTL_MS, input.notAfterMs ?? Infinity);
  const sig = fieldsSignature(input.secret, CONTEXT, [leadKey, scope, String(expiresAtMs)]);
  return { value: `${leadKey}.${scope}.${expiresAtMs}.${sig}`, expiresAtMs };
}

/**
 * Read a presented token for the lead and the booking the REQUEST names, never the ones the
 * token names: a good token for one lead or one booking is refused for any other. The
 * signature is judged before anything it covers, so an altered token is always `forged` and
 * never reads as an honest one that merely expired. Never throws.
 */
export function readProgramLeadToken(
  token: string | null | undefined,
  ask: { salesforceId: string; bookingId: string | null; secret: string; nowMs: number },
): { ok: true; facts: ProgramLeadFacts } | { ok: false; reason: ProgramLeadTokenRefusal } {
  if (!ask.secret) return { ok: false, reason: "secret-unset" };
  if (!token) return { ok: false, reason: "missing" };
  if (token.length > 256) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 4) return { ok: false, reason: "malformed" };
  const [leadKey, scope, expRaw, sig] = parts;
  if (
    !/^00Q[0-9A-Za-z]{12}$/.test(leadKey) ||
    !(scope === NEW_SCOPE || BOOKING_ID.test(scope)) ||
    !/^\d{1,16}$/.test(expRaw) ||
    !/^[0-9a-f]{1,64}$/.test(sig)
  ) {
    return { ok: false, reason: "malformed" };
  }
  if (!fieldsSignatureMatches(ask.secret, CONTEXT, [leadKey, scope, expRaw], sig)) {
    return { ok: false, reason: "forged" };
  }
  if (leadKey !== leadIdKey(ask.salesforceId.trim())) return { ok: false, reason: "other-lead" };
  const bookingId = scope === NEW_SCOPE ? null : scope;
  if (bookingId !== ask.bookingId) return { ok: false, reason: "other-booking" };
  const expiresAtMs = Number(expRaw);
  if (ask.nowMs >= expiresAtMs) return { ok: false, reason: "expired" };
  return {
    ok: true,
    facts: { leadKey, purpose: bookingId === null ? "new" : "move", bookingId, expiresAtMs },
  };
}

/**
 * Read a token for the lead and scope it CARRIES (#4390): for the times read, which names
 * no lead and no booking, so there is nothing of the request's own to hold it against. The
 * signature, the secret and the expiry are judged exactly as `readProgramLeadToken` judges
 * them, so a relabelled token is still `forged`. A good token here unlocks only the extra
 * times on screen; the booking and the move (#4391) read it with `readProgramLeadToken`
 * against the lead and booking they act on. Never throws.
 */
export function readProgramLeadTokenAsIssued(
  token: string | null | undefined,
  ask: { secret: string; nowMs: number },
): { ok: true; facts: ProgramLeadFacts } | { ok: false; reason: ProgramLeadTokenRefusal } {
  const [leadKey = "", scope = ""] = (token ?? "").split(".");
  return readProgramLeadToken(token, {
    salesforceId: leadKey,
    bookingId: scope === NEW_SCOPE ? null : scope,
    secret: ask.secret,
    nowMs: ask.nowMs,
  });
}
