// #4006: the pure decisions behind `scripts/verify-marcia-lead-fill-live.ts`, pinned offline
// (`scripts/lib/marcia-lead-fill-check.ts`), so the live run is spent only on what no
// fixture can answer: the deployed Worker's Salesforce Lead read, against the real org.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-marcia-lead-fill-check.ts
import { readFileSync } from "node:fs";
import {
  LEAD_FILL_OUTCOMES,
  fillVerdict,
  finalOutcome,
  leadFillClaims,
  leadIdProblem,
  leadProblem,
  readToolAnswer,
  runNonce,
  samePhone,
  slateAnswersFirst,
  tokenKeyFrom,
  toolCall,
} from "./lib/marcia-lead-fill-check.ts";
import { FIXTURE_TOKEN_KEY, signMachineToken, verifyMachineToken } from "../src/lib/mcp-booking/machine-token.ts";
import { PARTNER_BUCKET_CODE } from "../src/lib/embed/public-test-bucket.ts";
import { bookingBucketFor } from "../src/lib/mcp-booking/operations.ts";
import { liveTestWorldPreflight } from "./lib/live-test-world-preflight.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const NOW = Date.parse("2026-10-21T15:12:00.000Z");
const LEAD = "00QUl00000JtyVGMAZ";

// --- every outcome its own exit code ---------------------------------------------------
{
  const codes = Object.values(LEAD_FILL_OUTCOMES).map((o) => o.exit);
  eq(new Set(codes).size, codes.length, "every outcome exits on its own code");
  eq(LEAD_FILL_OUTCOMES.proven.exit, 0, "only the proof exits 0");
  // A read that failed is never reported as a finding about what it would have read (L11).
  assert(LEAD_FILL_OUTCOMES.slateUnreadable.exit !== LEAD_FILL_OUTCOMES.bookingsAnswerFirst.exit, "an unreadable bookings check is not Slate answering first");
  assert(LEAD_FILL_OUTCOMES.rowUnreadable.exit !== LEAD_FILL_OUTCOMES.notFilled.exit && LEAD_FILL_OUTCOMES.rowUnreadable.exit !== LEAD_FILL_OUTCOMES.mcpRefused.exit, "an unreadable moved row is neither a missing fill nor an MCP refusal");
}

// --- the lead id ----------------------------------------------------------------------
eq(leadIdProblem(LEAD), null, "an 18 character Lead id is accepted");
eq(leadIdProblem("00QUl00000JtyVG"), null, "a 15 character one too");
assert(leadIdProblem(undefined) !== null, "no lead id is refused");
assert(leadIdProblem("003Ul00000JtyVGMAZ") !== null, "a Contact id is not a Lead id");

// --- the token key: never echoed, never the fixture, never short --------------------------
{
  const real = "k".repeat(48);
  eq(tokenKeyFrom(`${real}\n`, undefined), { key: real }, "a key read from a file is trimmed");
  eq(tokenKeyFrom(null, real), { key: real }, "or taken from MARCIA_TOKEN_KEY_A");
  eq(tokenKeyFrom(real, "other".repeat(10)), { key: real }, "the file wins over the variable");
  for (const [raw, what] of [
    [null, "no key at all"],
    [FIXTURE_TOKEN_KEY, "the public fixture key"],
    ["q7Zx9Kw2", "a key too short to be the production one"],
  ] as const) {
    const r = tokenKeyFrom(raw, undefined);
    assert("problem" in r, `${what} is refused`);
    if ("problem" in r && raw) assert(!r.problem.includes(raw), `${what}: the refusal never repeats the value`);
  }
}

// --- the claims: a test token with no contact, which the verifier accepts --------------------
{
  const claims = leadFillClaims(LEAD, NOW, runNonce(NOW, 1));
  for (const k of ["name", "email", "phone"]) assert(!(k in claims), `the token carries no ${k}, so the move must fill it`);
  eq(claims.test, true, "the token is test flagged");
  eq(bookingBucketFor({ test: true, bucket_code: String(claims.bucket_code) }), PARTNER_BUCKET_CODE, "so every call lands on the partner test bucket");
  const token = await signMachineToken(claims, FIXTURE_TOKEN_KEY);
  const verified = await verifyMachineToken(token, [FIXTURE_TOKEN_KEY], NOW);
  assert(verified.ok, `Slate's own verifier accepts the token the run signs: ${verified.ok ? "" : verified.refusal.code}`);
  assert(runNonce(NOW, 1) !== runNonce(NOW, 2), "each call carries its own nonce, so the move is its own attempt");
}

// --- which Lead can prove it ------------------------------------------------------------
eq(leadProblem({ email: "dwright@trypennie.com", phone: "(212) 555-0123" }), null, "a Lead with a Pennie email and a phone can prove it");
assert(leadProblem(null) !== null, "a Lead Salesforce does not hold cannot");
assert(leadProblem({ email: null, phone: "2125550123" }) !== null, "nor one with no email");
assert(leadProblem({ email: "x@trypennie.com", phone: null }) !== null, "nor one with no phone");
assert(leadProblem({ email: "someone@gmail.com", phone: "2125550123" }) !== null, "nor one whose email is outside Pennie, which the moved invite would reach");
assert(leadProblem({ email: "x@trypennie.com.evil.example", phone: "2125550123" }) !== null, "a lookalike domain is outside Pennie too");

// --- whether Slate would answer before Salesforce ------------------------------------------
eq(slateAnswersFirst(null, 0), null, "no earlier booking and no active call: the Lead will be asked");
eq(slateAnswersFirst({ email: null, phone: null }, 0), null, "earlier bookings holding neither: the Lead will be asked");
assert(slateAnswersFirst({ email: "a@trypennie.com", phone: null }, 0) !== null, "an earlier booking holding an email answers first");
assert(slateAnswersFirst({ email: null, phone: "2125550123" }, 0) !== null, "and one holding a phone");
assert(slateAnswersFirst(null, 1) !== null, "an active call would be the one moved, so the run refuses");

// --- the verdict, by field, never by value -----------------------------------------------
{
  const lead = { email: "Dwright@TryPennie.com", phone: "(212) 555-0123" };
  eq(fillVerdict({ attendee_email: "dwright@trypennie.com", attendee_phone: "+12125550123" }, lead), { ok: true }, "the Lead's email and phone, however spelled, prove it");
  const none = fillVerdict({ attendee_email: null, attendee_phone: null }, lead);
  assert(!none.ok && none.why.includes("email not filled") && none.why.includes("phone not filled"), "nothing filled is named field by field");
  const other = fillVerdict({ attendee_email: "smoke@trypennie.com", attendee_phone: "+12125550123" }, lead);
  assert(!other.ok && other.why.includes("email filled with something other"), "an email from anywhere else is not the Lead's");
  assert(!other.ok && !other.why.includes("smoke@trypennie.com") && !other.why.includes("Dwright"), "and the verdict never carries a value");
  assert(!samePhone("555-0123", "555-0123"), "a number too short to be a whole one never matches");
}

// --- the MCP answer -----------------------------------------------------------------------
{
  const call = JSON.parse(toolCall(3, "move", { slot_id: "abc" }));
  eq([call.method, call.params.name, call.params.arguments.slot_id, call.id], ["tools/call", "move", "abc", 3], "a tools/call body names the tool and its arguments");
  const ok = readToolAnswer(200, JSON.stringify({ jsonrpc: "2.0", id: 1, result: { structuredContent: { ok: true, data: { outcome: "rescheduled" } }, isError: false } }));
  assert(ok.ok, "a tool answer with ok true is read");
  const refused = readToolAnswer(200, JSON.stringify({ jsonrpc: "2.0", id: 1, result: { structuredContent: { ok: false, code: "token_signature_invalid", class: "unexpected", message: "x" }, isError: true } }));
  assert(!refused.ok && refused.why.includes("token_signature_invalid"), "a refusal is named by its code");
  const unreachable = readToolAnswer(200, JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "Slate could not be reached just now." }], isError: true } }));
  assert(!unreachable.ok && unreachable.why.includes("no structured content"), "an answer without Slate's body says Slate was not reached");
  const shape = readToolAnswer(401, JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "The lead token is not a well formed signed token." } }));
  assert(!shape.ok && shape.why.includes("401") && shape.why.includes("-32001"), "a protocol refusal is named by its status and code");
  const garbage = readToolAnswer(502, "<html>bad gateway</html>");
  assert(!garbage.ok && garbage.why.includes("not JSON"), "a body that is not JSON is said to be so");
}

// --- how a run ends: cleanup wins the code, the run's result stays in the message ----------
{
  eq(finalOutcome({ outcome: "proven" }, null), { outcome: "proven" }, "a clean cleanup leaves the run's own result");
  eq(finalOutcome({ outcome: "notFilled", detail: "phone not filled" }, null).outcome, "notFilled", "a failed run with a clean cleanup exits as the failure");
  const both = finalOutcome({ outcome: "mcpRefused", detail: "move: refused slot_taken (expected)" }, { outcome: "residue", detail: "booking b1 is confirmed; cancel it by hand" });
  eq(both.outcome, "residue", "a call left behind wins the exit code");
  assert(both.detail?.includes("b1") === true && both.detail.includes("slot_taken"), "and the message keeps what the run found before cleanup");
  const provenThenUnread = finalOutcome({ outcome: "proven" }, { outcome: "cleanupUnverified", detail: "read booking b1" });
  assert(provenThenUnread.outcome === "cleanupUnverified" && provenThenUnread.detail?.includes("had proven") === true, "a proof whose cleanup is unread says both");
}

// --- the live script's wiring: each unreadable read exits as itself ------------------------
{
  const src = readFileSync(new URL("./verify-marcia-lead-fill-live.ts", import.meta.url), "utf8");
  const catchOfBookings = src.slice(src.indexOf("readKnownContact"), src.indexOf("if (first)"));
  assert(catchOfBookings.includes('exit("slateUnreadable"') && !catchOfBookings.includes('exit("bookingsAnswerFirst"'), "an unreadable bookings check exits slateUnreadable, never as Slate answering first");
  const rowRead = src.slice(src.indexOf('select("attendee_email, attendee_phone")'), src.indexOf("fillVerdict(row"));
  assert(rowRead.includes('outcome: "rowUnreadable"'), "an unreadable moved row is tagged rowUnreadable");
  assert(src.includes('?? "unexpected"') && !src.includes('?? "mcpRefused"'), "a throw no step tagged is unexpected, never an MCP refusal");
  assert(src.includes("finalOutcome(outcome, cleanup)") && !/exit\("(residue|cleanupUnverified)"/.test(src), "cleanup ends through finalOutcome, so the run's result is never dropped");
}

// --- the shared preflight: credentials, then the canary's window --------------------------
{
  const creds = { SUPABASE_SECRET_KEY: "x", NEXT_PUBLIC_SUPABASE_URL: "https://x.example" };
  eq(liveTestWorldPreflight({}, Date.parse("2026-10-21T15:12:00Z"))?.outcome, "notConfigured", "no Supabase credentials refuses first");
  eq(liveTestWorldPreflight(creds, Date.parse("2026-10-21T15:12:00Z")), null, "twelve past the hour, clear of the canary, goes ahead");
  eq(liveTestWorldPreflight(creds, Date.parse("2026-10-21T15:02:00Z"))?.outcome, "canaryWindow", "two past the hour meets the canary");
  eq(liveTestWorldPreflight(creds, Date.parse("2026-10-21T15:24:00Z"))?.outcome, "canaryWindow", "a start whose run would reach the next window is refused too");
}

finish();
