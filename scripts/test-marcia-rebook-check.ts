// #3616: the pure decisions behind `scripts/verify-marcia-rebook-live.ts`, pinned offline
// (`scripts/lib/marcia-rebook-check.ts`), so the live run is spent only on what no fixture
// can answer: the deployed booking MCP booking, cancelling and booking the SAME time again,
// each with its own Google Calendar event.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-marcia-rebook-check.ts
import { readFileSync } from "node:fs";
import {
  REBOOK_OUTCOMES,
  bookVerdict,
  cancelVerdict,
  rebookClaims,
  rebookFinalOutcome,
  rebookNonce,
  sameSlotVerdict,
  type CallFacts,
} from "./lib/marcia-rebook-check.ts";
import { FIXTURE_TOKEN_KEY, signMachineToken, verifyMachineToken } from "../src/lib/mcp-booking/machine-token.ts";
import { PARTNER_BUCKET_CODE } from "../src/lib/embed/public-test-bucket.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const NOW = Date.parse("2026-10-28T19:12:00.000Z");
const LEAD = "00QUl00000JtyVGMAZ";
const CONTACT = { name: "Rebook Check", email: "someone@trypennie.com", phone: "+15555550123" };

// --- every outcome its own exit code ---------------------------------------------------
{
  const codes = Object.values(REBOOK_OUTCOMES).map((o) => o.exit);
  eq(new Set(codes).size, codes.length, "every outcome exits on its own code");
  eq(REBOOK_OUTCOMES.proven.exit, 0, "only the proof exits 0");
  // The finding this command exists for is the same time refused after a cancel, so it
  // must never share a code with a refusal of the FIRST book, which proves nothing about it.
  assert(REBOOK_OUTCOMES.rebookRefused.exit !== REBOOK_OUTCOMES.mcpRefused.exit, "a refused rebook is not a refused first book");
  assert(REBOOK_OUTCOMES.rowUnreadable.exit !== REBOOK_OUTCOMES.notProven.exit, "an unreadable row is not a disproof");
}

// --- the token: test flagged, partner bucket, the lead's contact on it ---------------------
{
  const claims = rebookClaims(LEAD, NOW, rebookNonce(NOW, 1), CONTACT);
  eq(claims.test, true, "test flagged, so Slate routes to a test bucket and sends no webhook");
  eq(claims.bucket_code, PARTNER_BUCKET_CODE, "the partner test bucket");
  eq(claims.salesforce_id, LEAD, "the test lead");
  // A net new book through Marcia needs all three on the token (operations.ts, Dan 2026-10-21),
  // and the second book is net new again once the first is cancelled.
  eq([claims.name, claims.email, claims.phone], [CONTACT.name, CONTACT.email, CONTACT.phone], "name, email and phone ride the token");
  assert(rebookNonce(NOW, 1) !== rebookNonce(NOW, 2), "each call its own nonce, so the second book is not read as a retry of the first");
  assert(rebookNonce(NOW, 1) !== rebookNonce(NOW + 1, 1), "a later run never reuses a nonce");
  const token = await signMachineToken(claims, FIXTURE_TOKEN_KEY);
  const verified = await verifyMachineToken(token, [FIXTURE_TOKEN_KEY], NOW);
  assert(verified.ok, "Slate's own verifier accepts the claims this run signs");
}

// --- a book, judged against the row and the advisor's calendar -------------------------------
const booked = (over: Partial<CallFacts> = {}): CallFacts => ({
  answer: { outcome: "created", booking_id: "b1", starts_at: "2026-10-29T14:00:00.000Z" },
  row: { id: "b1", status: "confirmed", starts_at: "2026-10-29T14:00:00.000Z", gcal_event_id: "ev1", agent_email: "smoketest@trypennie.com" },
  event: { status: "confirmed" },
  ...over,
});
{
  eq(bookVerdict(booked()), { ok: true }, "created, confirmed, and a live event on the calendar");
  assert(!bookVerdict(booked({ answer: { outcome: "deduped", booking_id: "b1", starts_at: "2026-10-29T14:00:00.000Z" } })).ok, "a dedupe is not a new booking");
  assert(!bookVerdict(booked({ row: { ...booked().row!, gcal_event_id: null } })).ok, "no event id means no calendar event");
  assert(!bookVerdict(booked({ event: null })).ok, "an event Google cannot find is not a calendar event");
  assert(!bookVerdict(booked({ event: { status: "cancelled" } })).ok, "a cancelled event is not a live one");
  assert(!bookVerdict(booked({ row: { ...booked().row!, status: "cancelled" } })).ok, "the row must be confirmed");
  assert(!bookVerdict(booked({ row: { ...booked().row!, id: "other" } })).ok, "the row read must be the booking the answer named");
}

// --- a cancel: the row cancelled and the event gone ----------------------------------------
const cancelled = (over: Partial<CallFacts> = {}): CallFacts => ({
  answer: { outcome: "cancelled", booking_id: "b1", starts_at: "2026-10-29T14:00:00.000Z" },
  row: { id: "b1", status: "cancelled", starts_at: "2026-10-29T14:00:00.000Z", gcal_event_id: "ev1", agent_email: "smoketest@trypennie.com" },
  event: null,
  ...over,
});
{
  eq(cancelVerdict(cancelled()), { ok: true }, "cancelled, and Google no longer has the event");
  eq(cancelVerdict(cancelled({ event: { status: "cancelled" } })), { ok: true }, "Google keeps a deleted event readable as cancelled");
  assert(!cancelVerdict(cancelled({ event: { status: "confirmed" } })).ok, "an event still live after the cancel blocks the time");
  assert(!cancelVerdict(cancelled({ answer: { outcome: "already_cancelled", booking_id: "b1", starts_at: "2026-10-29T14:00:00.000Z" } })).ok, "already_cancelled means this cancel did nothing");
  assert(!cancelVerdict(cancelled({ row: { ...cancelled().row!, status: "confirmed" } })).ok, "the row must read cancelled");
}

// --- the rebook: the SAME time, a different booking, a different event -----------------------
{
  const first = booked();
  const second = booked({
    answer: { outcome: "created", booking_id: "b2", starts_at: "2026-10-29T14:00:00.000Z" },
    row: { id: "b2", status: "confirmed", starts_at: "2026-10-29T14:00:00.000Z", gcal_event_id: "ev2", agent_email: "smoketest@trypennie.com" },
  });
  eq(sameSlotVerdict(first, second), { ok: true }, "same start, new booking, new event");
  const moved = { ...second, row: { ...second.row!, starts_at: "2026-10-29T14:30:00.000Z" } };
  assert(!sameSlotVerdict(first, moved).ok, "a different start is not a rebook of the same time");
  const revived = { ...second, answer: { ...second.answer!, booking_id: "b1" }, row: { ...second.row!, id: "b1" } };
  assert(!sameSlotVerdict(first, revived).ok, "the cancelled booking brought back is not a new booking");
  const sharedEvent = { ...second, row: { ...second.row!, gcal_event_id: "ev1" } };
  assert(!sameSlotVerdict(first, sharedEvent).ok, "the second booking must carry its own calendar event");
}

// --- cleanup wins the exit code, and keeps the run's own result in the message -------------
{
  eq(rebookFinalOutcome({ outcome: "proven" }, []), { outcome: "proven" }, "nothing left behind keeps the run's result");
  const end = rebookFinalOutcome({ outcome: "rebookRefused", detail: "slot_taken" }, [{ outcome: "residue", detail: "booking b1 is confirmed" }]);
  eq(end.outcome, "residue", "a call left on a calendar is the urgent thing");
  assert(end.detail!.includes("slot_taken") && end.detail!.includes("b1"), "both the leftover and the run's own failure are said");
  const worst = rebookFinalOutcome({ outcome: "proven" }, [{ outcome: "cleanupUnverified", detail: "b2 unread" }, { outcome: "residue", detail: "b1 confirmed" }]);
  eq(worst.outcome, "residue", "a known leftover outranks an unread one");
}

// --- the live script's wiring, read from its source ---------------------------------------
{
  const src = readFileSync(new URL("./verify-marcia-rebook-live.ts", import.meta.url), "utf8");
  assert(src.includes('process.env.VERIFY_MARCIA_REBOOK_APPLY !== "1"'), "it books nothing without the apply flag");
  assert(src.includes("liveTestWorldPreflight("), "it refuses inside the smoke canary's window");
  assert((src.match(/mcp\("book"/g) ?? []).length === 2, "both books go through the deployed booking MCP");
  assert((src.match(/mcp\("cancel"/g) ?? []).length >= 2, "both cancels go through the deployed booking MCP");
  assert(src.includes("slot_id: slot.slot_id") && !/slot_id: times\[1\]/.test(src), "the rebook uses the very slot the first book took");
  assert(src.includes("getEventOnPrimary("), "each event is asked of Google, never only of Slate's row");
  assert(src.includes('?? "unexpected"'), "a throw no step tagged is unexpected, never a refusal");
  assert(src.includes("rebookFinalOutcome(outcome, cleanup)"), "cleanup ends through rebookFinalOutcome, so the run's result is never dropped");
}

finish();
