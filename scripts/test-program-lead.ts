// Program leads (#4255, #4389): the one predicate and the signed token.
//
// `isProgramLead` is the ONE rule the page, the times, the booking and the move read, so
// the times shown and the booking accepted cannot disagree (L261). Every branch is driven
// here in both directions.
//
// The token is how the page hands that decision to the routes without the routes ever
// reading `program_leads` for an id a stranger supplies. Every refusal is PRODUCED here,
// each beside the good token it differs from, so a reader wired to "no" fails too (L1).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-program-lead.ts
import { createHmac } from "node:crypto";
import { isProgramLead } from "../src/lib/booking/program-lead.ts";
import {
  PROGRAM_LEAD_TOKEN_REFUSALS,
  PROGRAM_LEAD_TOKEN_TTL_MS,
  mintProgramLeadToken,
  readProgramLeadToken,
  readProgramLeadTokenAsIssued,
} from "../src/lib/booking/program-lead-token.ts";
import { fieldsSignature, fieldsSignatureMatches } from "../src/lib/signed-fields.ts";
import { mintTestPass, verifyTestPass } from "../src/lib/embed/test-pass.ts";
import { PUBLIC_TEST_BUCKET_CODES } from "../src/lib/embed/public-test-bucket.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const NOW = Date.UTC(2026, 9, 29, 15, 0, 0);
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

// --- isProgramLead -------------------------------------------------------------------
{
  // A new booking: a live registration and nothing else.
  eq(isProgramLead({ registration: { expires_at: iso(NOW + HOUR) }, nowMs: NOW }), true, "a new booking with a live registration is a program lead");
  eq(isProgramLead({ registration: { expires_at: iso(NOW) }, nowMs: NOW }), false, "a registration expiring this instant has lapsed");
  eq(isProgramLead({ registration: { expires_at: iso(NOW - HOUR) }, nowMs: NOW }), false, "a lapsed registration is not a program lead");
  eq(isProgramLead({ registration: null, nowMs: NOW }), false, "no registration is not a program lead");
  eq(isProgramLead({ nowMs: NOW }), false, "nothing known is not a program lead");
  eq(isProgramLead({ registration: { expires_at: "not a date" }, nowMs: NOW }), false, "an unreadable expiry is never read as live (L50)");
  eq(isProgramLead({ registration: { expires_at: "" }, nowMs: NOW }), false, "a blank expiry is never read as live");

  // A move: the booking's own mark and nothing else, so a lapsed registration does not
  // strand a program booking, and a live one does not promote an ordinary booking.
  eq(isProgramLead({ booking: { program_lead: true }, nowMs: NOW }), true, "moving a program booking is a program move");
  eq(
    isProgramLead({ booking: { program_lead: true }, registration: { expires_at: iso(NOW - HOUR) }, nowMs: NOW }),
    true,
    "a program booking stays one after its lead's registration lapses",
  );
  eq(isProgramLead({ booking: { program_lead: false }, nowMs: NOW }), false, "moving an ordinary booking is not a program move");
  eq(
    isProgramLead({ booking: { program_lead: false }, registration: { expires_at: iso(NOW + HOUR) }, nowMs: NOW }),
    false,
    "a live registration never makes an ordinary booking's move a program move",
  );
}

// --- the shared signer ----------------------------------------------------------------
{
  // The digest is HMAC SHA256 over the context and the fields joined by dots, so a pass the
  // test bucket minted before the signer was shared still verifies after it (#2666).
  const secret = "s".repeat(64);
  const expected = createHmac("sha256", secret).update("ctx.v1.a.b.3").digest("hex");
  eq(fieldsSignature(secret, "ctx.v1", ["a", "b", "3"]), expected, "the shared signer is HMAC SHA256 over context and fields joined by dots");
  assert(fieldsSignatureMatches(secret, "ctx.v1", ["a", "b", "3"], expected), "a matching signature matches");
  assert(!fieldsSignatureMatches(secret, "ctx.v2", ["a", "b", "3"], expected), "another context never matches: one secret, separate uses");
  assert(!fieldsSignatureMatches(secret, "ctx.v1", ["a", "b", "4"], expected), "another field never matches");
  assert(!fieldsSignatureMatches(secret, "ctx.v1", ["a", "b", "3"], ""), "an empty signature never matches");

  const pass = mintTestPass({ code: PUBLIC_TEST_BUCKET_CODES[0], secret, nowMs: NOW });
  const [, exp] = pass.value.split(".");
  eq(
    pass.value,
    `${PUBLIC_TEST_BUCKET_CODES[0]}.${exp}.${createHmac("sha256", secret).update(`slate-test-pass.v1.${PUBLIC_TEST_BUCKET_CODES[0]}.${exp}`).digest("hex")}`,
    "the test pass is byte for byte what it was before the signer was shared",
  );
  eq(verifyTestPass({ pass: pass.value, code: PUBLIC_TEST_BUCKET_CODES[0], secret, nowMs: NOW }), { ok: true }, "the test pass still verifies through the shared signer");
}

// --- the token ----------------------------------------------------------------------
const SECRET = "k".repeat(64);
const LEAD_18 = "00Q5f00000AbCdEFGH";
const LEAD_15 = LEAD_18.slice(0, 15);
const OTHER_LEAD = "00Q5f00000ZzZzZ";
const BOOKING = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const OTHER_BOOKING = "11111111-2222-4333-8444-555555555555";

type Ask = { salesforceId?: string; bookingId?: string | null; secret?: string; nowMs?: number };
function reading(token: string | null, ask: Ask = {}) {
  const r = readProgramLeadToken(token, {
    salesforceId: ask.salesforceId ?? LEAD_18,
    bookingId: ask.bookingId ?? null,
    secret: ask.secret ?? SECRET,
    nowMs: ask.nowMs ?? NOW,
  });
  return r.ok ? "ok" : r.reason;
}

{
  // A new booking's token.
  const t = mintProgramLeadToken({ salesforceId: LEAD_18, bookingId: null, secret: SECRET, nowMs: NOW });
  eq(t.expiresAtMs, NOW + PROGRAM_LEAD_TOKEN_TTL_MS, "a token expires one TTL after it was made");
  assert(!t.value.includes(SECRET), "the token never carries the secret");
  const ok = readProgramLeadToken(t.value, { salesforceId: LEAD_18, bookingId: null, secret: SECRET, nowMs: NOW });
  eq(ok, { ok: true, facts: { leadKey: LEAD_15, purpose: "new", bookingId: null, expiresAtMs: NOW + PROGRAM_LEAD_TOKEN_TTL_MS } }, "a fresh token reads back its facts");
  eq(reading(t.value, { salesforceId: LEAD_15 }), "ok", "the 15 character spelling of the same lead is the same lead");
  eq(reading(t.value, { nowMs: NOW + PROGRAM_LEAD_TOKEN_TTL_MS - 1 }), "ok", "a token is good to the last millisecond of its life");

  eq(reading(t.value, { nowMs: NOW + PROGRAM_LEAD_TOKEN_TTL_MS }), "expired", "a token at its expiry is refused as expired");
  eq(reading(t.value, { salesforceId: OTHER_LEAD }), "other-lead", "a token issued for another lead is refused");
  eq(reading(t.value, { bookingId: BOOKING }), "other-booking", "a new booking's token cannot move a booking");
  eq(reading(t.value, { secret: "j".repeat(64) }), "forged", "a token signed with another secret is refused");
  eq(reading(t.value, { secret: "" }), "secret-unset", "with no secret nothing verifies, the good token included");
  eq(reading(null), "missing", "no token is refused as missing");
  eq(reading(""), "missing", "an empty token is refused as missing");
  eq(reading("nonsense"), "malformed", "a value with no token shape is refused as malformed");
  eq(reading(`${t.value}.extra`), "malformed", "a token with an extra part is refused as malformed");

  // Tampering: every field is under the signature.
  const [lead, scope, exp, sig] = t.value.split(".");
  eq(reading(`${lead}.${scope}.${Number(exp) + HOUR}.${sig}`, { nowMs: NOW + PROGRAM_LEAD_TOKEN_TTL_MS + 1 }), "forged", "an extended expiry is refused as forged, never read as fresh");
  eq(reading(`${OTHER_LEAD}.${scope}.${exp}.${sig}`, { salesforceId: OTHER_LEAD }), "forged", "a token relabelled for another lead is refused");
  eq(reading(`${lead}.${BOOKING}.${exp}.${sig}`, { bookingId: BOOKING }), "forged", "a new booking's token relabelled for a booking is refused");
  eq(reading(`${lead}.${scope}.${exp}.${sig.slice(0, -2)}`), "forged", "a truncated signature is refused");
  eq(reading(`${lead}.${scope}.${exp}.${sig}zz`), "malformed", "a signature that is not hex is refused");

  // A Salesforce id that is not a Lead never gets a token at all.
  let threw = false;
  try {
    mintProgramLeadToken({ salesforceId: "001AAAAAAAAAAAA", bookingId: null, secret: SECRET, nowMs: NOW });
  } catch {
    threw = true;
  }
  assert(threw, "minting refuses an id that is not a Lead id");
  let threwNoSecret = false;
  try {
    mintProgramLeadToken({ salesforceId: LEAD_18, bookingId: null, secret: "", nowMs: NOW });
  } catch {
    threwNoSecret = true;
  }
  assert(threwNoSecret, "minting refuses an empty secret rather than signing with it");
}

{
  // The token never outlives the registration it was issued on.
  const t = mintProgramLeadToken({ salesforceId: LEAD_18, bookingId: null, secret: SECRET, nowMs: NOW, notAfterMs: NOW + 10 * 60_000 });
  eq(t.expiresAtMs, NOW + 10 * 60_000, "a registration lapsing sooner than the TTL caps the token");
  eq(reading(t.value, { nowMs: NOW + 10 * 60_000 }), "expired", "the capped token is refused once the registration has lapsed");
  const far = mintProgramLeadToken({ salesforceId: LEAD_18, bookingId: null, secret: SECRET, nowMs: NOW, notAfterMs: NOW + 30 * 24 * HOUR });
  eq(far.expiresAtMs, NOW + PROGRAM_LEAD_TOKEN_TTL_MS, "a registration lapsing later than the TTL leaves the TTL");
}

{
  // A move token, for one booking.
  const t = mintProgramLeadToken({ salesforceId: LEAD_15, bookingId: BOOKING, secret: SECRET, nowMs: NOW });
  const ok = readProgramLeadToken(t.value, { salesforceId: LEAD_18, bookingId: BOOKING, secret: SECRET, nowMs: NOW });
  eq(ok, { ok: true, facts: { leadKey: LEAD_15, purpose: "move", bookingId: BOOKING, expiresAtMs: NOW + PROGRAM_LEAD_TOKEN_TTL_MS } }, "a move token reads back the booking it moves");
  eq(reading(t.value, { bookingId: OTHER_BOOKING }), "other-booking", "a move token issued for another booking is refused");
  eq(reading(t.value, { bookingId: null }), "other-booking", "a move token cannot make a new booking");
  eq(reading(t.value, { bookingId: BOOKING, salesforceId: OTHER_LEAD }), "other-lead", "a move token presented for another lead is refused");
  eq(reading(t.value, { bookingId: BOOKING, nowMs: NOW + PROGRAM_LEAD_TOKEN_TTL_MS }), "expired", "a move token expires too");
}

{
  // #4390: the times read names no lead and no booking, so a token is judged as issued:
  // its signature, its secret and its expiry, for whichever lead and scope it carries.
  const asIssued = (token: string | null, ask: { secret?: string; nowMs?: number } = {}) => {
    const r = readProgramLeadTokenAsIssued(token, { secret: ask.secret ?? SECRET, nowMs: ask.nowMs ?? NOW });
    return r.ok ? r.facts.purpose : r.reason;
  };
  const fresh = mintProgramLeadToken({ salesforceId: LEAD_18, bookingId: null, secret: SECRET, nowMs: NOW });
  const move = mintProgramLeadToken({ salesforceId: LEAD_18, bookingId: BOOKING, secret: SECRET, nowMs: NOW });
  eq(asIssued(fresh.value), "new", "a new booking's token reads as issued");
  eq(asIssued(move.value), "move", "and so does a move token, for the booking it names");
  eq(asIssued(fresh.value, { nowMs: fresh.expiresAtMs }), "expired", "an expired token is refused");
  eq(asIssued(fresh.value, { secret: "j".repeat(64) }), "forged", "a token signed with another secret is refused");
  eq(asIssued(fresh.value, { secret: "" }), "secret-unset", "with no secret nothing reads, so the caller can count it");
  const [, scope, exp, sig] = fresh.value.split(".");
  eq(asIssued(`${OTHER_LEAD}.${scope}.${exp}.${sig}`), "forged", "a token relabelled for another lead is refused");
  eq(asIssued(`${LEAD_15}.${BOOKING}.${exp}.${sig}`), "forged", "a new booking's token relabelled as a move is refused");
  eq(asIssued(null), "missing", "no token is missing");
  eq(asIssued("x.y"), "malformed", "a short value is malformed");
}

{
  // The TTL is the time a lead may sit on the texted page, not a day.
  assert(PROGRAM_LEAD_TOKEN_TTL_MS === 2 * HOUR, "the token lives two hours");

  const produced = new Set(["missing", "malformed", "forged", "secret-unset", "expired", "other-lead", "other-booking"]);
  for (const r of PROGRAM_LEAD_TOKEN_REFUSALS) assert(produced.has(r), `the refusal ${r} is produced by a case above`);
  eq(PROGRAM_LEAD_TOKEN_REFUSALS.length, produced.size, "every refusal produced above is declared");
}

finish();
