import {
  formatLeadTime,
  reasonLabel,
  attributionLine,
  toBookingEventView,
  buildHistoryViews,
} from "../src/lib/booking/event-display.ts";
import { formatSlotDay, formatSlotTime } from "../src/lib/booking/slot-label.ts";
import type { BookingEvent } from "../src/lib/db/types.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const TZ = "America/New_York";

// --- formatLeadTime: signed minutes -> human "before"/"after" the appointment ---
eq(formatLeadTime(2880), "2 days before", "2880 min -> 2 days before");
eq(formatLeadTime(1440), "1 day before", "1440 min -> 1 day before");
eq(formatLeadTime(180), "3 hours before", "180 min -> 3 hours before");
eq(formatLeadTime(60), "1 hour before", "60 min -> 1 hour before");
eq(formatLeadTime(45), "45 minutes before", "45 min -> 45 minutes before");
eq(formatLeadTime(1), "1 minute before", "1 min -> 1 minute before");
eq(formatLeadTime(-120), "2 hours after", "-120 min -> 2 hours after (action after the appt)");
eq(formatLeadTime(0), "at the scheduled time", "0 min -> at the scheduled time");
eq(formatLeadTime(null), null, "null lead -> null");

// --- reasonLabel: code -> human label, with "other" free text + unknown-code fallback ---
eq(
  reasonLabel("cancel", "no_longer_interested", null),
  "No longer interested",
  "known cancel code -> its label",
);
eq(
  reasonLabel("reschedule", "other", "Kid got sick"),
  "Kid got sick",
  "'other' -> the free-text detail",
);
eq(reasonLabel("cancel", "other", null), "Other", "'other' with no detail -> 'Other'");
eq(
  reasonLabel("reassign", "owner_reassignment", null),
  "Owner reassignment",
  "known reassign code -> its label",
);
eq(
  reasonLabel("cancel", "api_cancellation", null),
  "Api cancellation",
  "unknown/system code -> humanized fallback",
);

// --- attributionLine: who drove the event, incl. impersonation ---
const names: Record<string, string> = { u1: "Dan Wright", u2: "Jo Lee" };
const nameOf = (id: string | null) => (id ? names[id] ?? "Unknown user" : "Unknown user");

const base: BookingEvent = {
  id: "e1",
  booking_id: "b1",
  action: "rescheduled",
  initiator: "admin",
  reason_code: "schedule_conflict",
  reason_detail: null,
  from_starts_at: null,
  to_starts_at: null,
  from_agent_user_id: null,
  to_agent_user_id: null,
  actor_user_id: null,
  acting_as_user_id: null,
  lead_time_minutes: null,
  reschedule_seq: null,
  created_at: "2026-07-02T14:03:00Z",
};

eq(attributionLine({ ...base, initiator: "customer" }, nameOf), "Customer", "customer -> Customer");
eq(
  attributionLine({ ...base, initiator: "system" }, nameOf),
  "System (automated)",
  "system -> System (automated)",
);
eq(
  attributionLine({ ...base, initiator: "admin", actor_user_id: "u1" }, nameOf),
  "Dan Wright (admin)",
  "admin with actor -> name (admin)",
);
eq(
  attributionLine(
    { ...base, initiator: "admin", actor_user_id: "u1", acting_as_user_id: "u2" },
    nameOf,
  ),
  "Dan Wright, acting as Jo Lee",
  "admin impersonating -> 'X, acting as Y'",
);
eq(
  attributionLine({ ...base, initiator: "admin", actor_user_id: null }, nameOf),
  "Admin",
  "admin historical (no actor) -> 'Admin'",
);
eq(
  attributionLine({ ...base, initiator: "agent", actor_user_id: "u2" }, nameOf),
  "Jo Lee (agent)",
  "agent with actor -> name (agent)",
);

// --- toBookingEventView: composed view model the panel renders ---
const reschedule: BookingEvent = {
  ...base,
  action: "rescheduled",
  initiator: "admin",
  actor_user_id: "u1",
  reason_code: "schedule_conflict",
  from_starts_at: "2026-07-03T18:00:00Z",
  to_starts_at: "2026-07-05T18:00:00Z",
  lead_time_minutes: 2880,
};
const rv = toBookingEventView(reschedule, nameOf, TZ);
eq(rv.actionLabel, "Rescheduled", "reschedule -> actionLabel Rescheduled");
eq(rv.who, "Dan Wright (admin)", "reschedule who");
eq(rv.reason, "Schedule conflict", "reschedule reason label");
eq(rv.lead, "2 days before", "reschedule lead");
const expectFrom = `${formatSlotDay("2026-07-03T18:00:00Z", TZ)}, ${formatSlotTime("2026-07-03T18:00:00Z", TZ)}`;
const expectTo = `${formatSlotDay("2026-07-05T18:00:00Z", TZ)}, ${formatSlotTime("2026-07-05T18:00:00Z", TZ)}`;
eq(rv.timeChange, `${expectFrom} → ${expectTo}`, "reschedule timeChange from -> to");
eq(rv.agentChange, null, "reschedule with no agent change -> null");

const reassign: BookingEvent = {
  ...base,
  action: "reassigned",
  initiator: "admin",
  actor_user_id: "u1",
  reason_code: "coverage",
  from_agent_user_id: "u2",
  to_agent_user_id: "u1",
};
const av = toBookingEventView(reassign, nameOf, TZ);
eq(av.actionLabel, "Reassigned", "reassign -> actionLabel Reassigned");
eq(av.agentChange, "Jo Lee → Dan Wright", "reassign agentChange from -> to (names)");
eq(av.timeChange, null, "reassign with no time change -> null");
eq(av.reason, "Coverage (agent unavailable)", "reassign reason label");

const cancel: BookingEvent = {
  ...base,
  action: "cancelled",
  initiator: "customer",
  actor_user_id: null,
  reason_code: "no_longer_interested",
  lead_time_minutes: -240,
};
const cv = toBookingEventView(cancel, nameOf, TZ);
eq(cv.actionLabel, "Cancelled", "cancel -> actionLabel Cancelled");
eq(cv.who, "Customer", "cancel who = Customer");
eq(cv.lead, "4 hours after", "cancel lead after the appt");
assert(cv.timeChange === null && cv.agentChange === null, "cancel has no time/agent change");

// --- buildHistoryViews: newest-first + roster name resolution (name ?? email) ---
const roster = [
  { id: "u1", name: "Dan Wright", email: "dan@x.co" },
  { id: "u2", name: null, email: "jo@x.co" },
];
const older: BookingEvent = {
  ...base,
  id: "old",
  action: "reassigned",
  initiator: "admin",
  actor_user_id: "u1",
  reason_code: "coverage",
  from_agent_user_id: "u1",
  to_agent_user_id: "u2",
  created_at: "2026-07-01T09:00:00Z",
};
const newer: BookingEvent = {
  ...base,
  id: "new",
  action: "cancelled",
  initiator: "customer",
  reason_code: "no_longer_interested",
  created_at: "2026-07-04T09:00:00Z",
};
const views = buildHistoryViews([older, newer], roster, TZ);
eq(views.length, 2, "buildHistoryViews returns one view per event");
eq(views[0].id, "new", "newest event first");
eq(views[1].id, "old", "older event last");
eq(views[1].agentChange, "Dan Wright → jo@x.co", "roster name falls back to email when name is null");

const unknown: BookingEvent = {
  ...base,
  id: "unk",
  action: "reassigned",
  initiator: "admin",
  actor_user_id: "ghost",
  reason_code: "coverage",
  from_agent_user_id: "ghost",
  to_agent_user_id: "u1",
  created_at: "2026-07-05T09:00:00Z",
};
const uv = buildHistoryViews([unknown], roster, TZ);
eq(uv[0].agentChange, "Unknown user → Dan Wright", "id absent from roster -> 'Unknown user'");

eq(buildHistoryViews([], roster, TZ).length, 0, "no events -> empty list");

finish();
