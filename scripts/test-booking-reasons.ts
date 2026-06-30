// Pure core for reschedule/cancel reason capture + history events (#326/#300).
// Run: node --experimental-strip-types scripts/test-booking-reasons.ts
import {
  RESCHEDULE_REASONS,
  CANCEL_REASONS,
  REASON_DETAIL_MAX,
  validateReason,
  bookingEventFrom,
} from "../src/lib/booking/core.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    failures++;
  } else console.log("ok:", msg);
}

// --- validateReason: mandatory, list-bound, "other" requires detail ---
{
  const r = validateReason("reschedule", { code: "schedule_conflict" });
  assert(r.ok && r.reason.code === "schedule_conflict" && r.reason.detail === null, "valid reschedule code, no detail");
}
{
  const r = validateReason("cancel", { code: "booked_by_mistake" });
  assert(r.ok && r.reason.code === "booked_by_mistake", "valid cancel code");
}
{
  const r = validateReason("reschedule", { code: "" });
  assert(!r.ok, "missing code is rejected (mandatory)");
}
{
  const r = validateReason("reschedule", {});
  assert(!r.ok, "absent code is rejected (mandatory)");
}
{
  // A cancel-only code is not valid for reschedule.
  const r = validateReason("reschedule", { code: "no_longer_interested" });
  assert(!r.ok, "a code from the other action's list is rejected");
}
{
  const r = validateReason("cancel", { code: "other" });
  assert(!r.ok, "'other' with no detail is rejected");
}
{
  const r = validateReason("cancel", { code: "other", detail: "   " });
  assert(!r.ok, "'other' with whitespace-only detail is rejected");
}
{
  const r = validateReason("cancel", { code: "other", detail: "  changed my mind  " });
  assert(r.ok && r.reason.code === "other" && r.reason.detail === "changed my mind", "'other' detail is trimmed and kept");
}
{
  const long = "x".repeat(REASON_DETAIL_MAX + 1);
  const r = validateReason("cancel", { code: "other", detail: long });
  assert(!r.ok, "'other' detail over the max length is rejected");
}
{
  // Detail on a non-"other" code is discarded (not stored).
  const r = validateReason("reschedule", { code: "found_better_time", detail: "ignored" });
  assert(r.ok && r.reason.detail === null, "detail on a non-other code is dropped");
}
{
  // The option lists expose code + label and both include "other".
  assert(RESCHEDULE_REASONS.some((o) => o.code === "other") && RESCHEDULE_REASONS.every((o) => o.code && o.label), "reschedule options have code+label incl. other");
  assert(CANCEL_REASONS.some((o) => o.code === "other"), "cancel options include other");
}

// --- bookingEventFrom: builds the history row, signed lead time, agent change ---
const NOW = Date.parse("2026-06-08T11:00:00.000Z"); // 2h before a 13:00 appt
{
  const ev = bookingEventFrom({
    bookingId: "bk1",
    action: "rescheduled",
    initiator: "customer",
    reason: { code: "schedule_conflict", detail: null },
    fromStartsIso: "2026-06-08T13:00:00.000Z",
    toStartsIso: "2026-06-09T15:00:00.000Z",
    fromAgentUserId: "a",
    toAgentUserId: "b",
    nowMs: NOW,
  });
  assert(ev.booking_id === "bk1" && ev.action === "rescheduled" && ev.initiator === "customer", "carries id/action/initiator");
  assert(ev.reason_code === "schedule_conflict" && ev.reason_detail === null, "carries reason");
  assert(ev.from_starts_at === "2026-06-08T13:00:00.000Z" && ev.to_starts_at === "2026-06-09T15:00:00.000Z", "carries from/to time");
  assert(ev.from_agent_user_id === "a" && ev.to_agent_user_id === "b", "carries agent change");
  assert(ev.lead_time_minutes === 120, "lead time = +120 min before the (old) appointment");
  // #549: a customer self-serve action has no staff actor.
  assert(ev.actor_user_id === null && ev.acting_as_user_id === null, "customer action records no staff actor");
}
// #549: an admin action records WHICH staff user performed it; an impersonated
// action records the real admin as the actor + who they acted as.
{
  const plain = bookingEventFrom({
    bookingId: "bk1",
    action: "cancelled",
    initiator: "admin",
    reason: { code: "booked_by_mistake", detail: null },
    fromStartsIso: "2026-06-08T13:00:00.000Z",
    toStartsIso: null,
    fromAgentUserId: "a",
    toAgentUserId: null,
    actorUserId: "mgr1",
    nowMs: NOW,
  });
  assert(plain.actor_user_id === "mgr1" && plain.acting_as_user_id === null, "admin action records the acting staff user, no impersonation");

  const impersonated = bookingEventFrom({
    bookingId: "bk1",
    action: "rescheduled",
    initiator: "admin",
    reason: { code: "schedule_conflict", detail: null },
    fromStartsIso: "2026-06-08T13:00:00.000Z",
    toStartsIso: "2026-06-09T15:00:00.000Z",
    fromAgentUserId: "a",
    toAgentUserId: "b",
    actorUserId: "admin1",
    actingAsUserId: "mgr2",
    nowMs: NOW,
  });
  assert(impersonated.actor_user_id === "admin1" && impersonated.acting_as_user_id === "mgr2", "impersonated action: real admin is the actor, target recorded as acting-as");
}
{
  // Action after the appointment start -> negative lead time (rounded).
  const ev = bookingEventFrom({
    bookingId: "bk1",
    action: "cancelled",
    initiator: "customer",
    reason: { code: "other", detail: "no longer needed" },
    fromStartsIso: "2026-06-08T10:30:00.000Z", // 30m before NOW
    toStartsIso: null,
    fromAgentUserId: "a",
    toAgentUserId: null,
    nowMs: NOW,
  });
  assert(ev.lead_time_minutes === -30, "lead time is negative when the action happens after the scheduled time");
  assert(ev.to_starts_at === null, "cancel has no to-time");
  assert(ev.reason_detail === "no longer needed", "cancel carries the other-detail");
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
