// #3249: a reassign that lands on an advisor held for a bucket correction.
//
// The bookings trigger (migration 0166) refuses it as a lost race (23P01) under the
// constraint name `reroute_hold`, with the hold's end in the error detail. The
// admin reassign must answer that as its own refusal, "held for a bucket
// correction until HH:MM ET", never as a generic failure or a slot taken.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-reroute-held.ts
import { AgentHeldError, agentHeldFrom, heldUntilSentence } from "../src/lib/booking/reroute.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// What PostgREST hands back for the trigger's raise.
const raised = {
  code: "23P01",
  message: "agent 8f0e... is held for a bucket correction until 2026-10-05 19:04:00+00",
  details: "held_until=2026-10-05T19:04:00Z",
  hint: "A reroute hold is a lost race for this agent and window; route to another agent.",
};

{
  const held = agentHeldFrom(raised);
  assert(held instanceof AgentHeldError, "the trigger's refusal becomes a typed held error");
  eq(held?.heldUntilIso ?? null, "2026-10-05T19:04:00Z", "carrying the hold's end from the detail");
}
eq(agentHeldFrom({ code: "23P01", message: "conflicting key value violates exclusion constraint \"bookings_no_overlap\"", details: "Key (...)" }), null,
  "an ordinary overlap is NOT a hold: it stays the lost race it is");
eq(agentHeldFrom({ code: "23505", message: "duplicate key", details: null }), null, "a unique violation is not a hold");
eq(agentHeldFrom(null), null, "no error is no hold");
eq(agentHeldFrom({ ...raised, details: null }), null,
  "the decision rests on the structured detail, never the message's wording (L35)");
{
  const held = agentHeldFrom({ ...raised, details: "held_until=not a time" });
  assert(held instanceof AgentHeldError && held.heldUntilIso === null, "a hold whose end cannot be read is still a hold");
}

eq(heldUntilSentence("2026-10-05T19:04:00Z"), "This advisor is held for a bucket correction until 3:04pm ET.", "the end is said in Eastern time");
eq(heldUntilSentence("2026-01-05T19:04:00Z"), "This advisor is held for a bucket correction until 2:04pm ET.", "including outside daylight saving");
eq(heldUntilSentence(null), "This advisor is held for a bucket correction for a few more minutes.", "an unreadable end still says what is happening");

finish();
