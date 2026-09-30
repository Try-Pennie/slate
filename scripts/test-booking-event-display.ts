import {
  formatLeadTime,
  reasonLabel,
  attributionLine,
  toBookingEventView,
  buildHistoryViews,
} from "../src/lib/booking/event-display.ts";
import {
  RESCHEDULE_REASONS,
  CANCEL_REASONS,
  REASSIGN_REASONS,
  type ReasonAction,
  type ReasonOption,
} from "../src/lib/booking/core.ts";
import type { BookingEvent } from "../src/lib/db/types.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// #346: history label rendering resolves a code against the live option set
// (passed in), so a renamed/custom code shows the admin's exact current label.
const OPTS: Record<ReasonAction, ReasonOption[]> = {
  reschedule: RESCHEDULE_REASONS,
  cancel: CANCEL_REASONS,
  reassign: REASSIGN_REASONS,
};

// --- formatLeadTime: signed minutes -> human, and it NAMES ITS ANCHOR (#1943) ---
//
// It read "4 hours before", which is a dangling comparative: nothing on screen
// said before what, and the reader's only available guess (before the previous
// entry) is wrong. `bookingEventFrom` measures it against the PRE ACTION
// appointment time, so three reschedules in a row show a growing notice period
// against one unchanging clock time, which reads as a data fault and is not.
const ANCHOR = "the time it was booked for then";
eq(formatLeadTime(2880, true), `2 days before ${ANCHOR}`, "2880 min -> 2 days before");
eq(formatLeadTime(1440, true), `1 day before ${ANCHOR}`, "1440 min -> 1 day before");
eq(formatLeadTime(180, true), `3 hours before ${ANCHOR}`, "180 min -> 3 hours before");
eq(formatLeadTime(60, true), `1 hour before ${ANCHOR}`, "60 min -> 1 hour before");
eq(formatLeadTime(45, true), `45 minutes before ${ANCHOR}`, "45 min -> 45 minutes before");
eq(formatLeadTime(1, true), `1 minute before ${ANCHOR}`, "1 min -> 1 minute before");
eq(formatLeadTime(-120, true), `2 hours after ${ANCHOR}`, "-120 min -> after the appointment");
eq(formatLeadTime(0, true), "at the time it was booked for", "0 min -> at the booked time");
eq(formatLeadTime(null, true), null, "null lead -> null");

// Every phrase a MOVING entry can produce names its moving anchor, or the fix is
// only in the cases somebody happened to list.
for (const m of [2880, 1440, 180, 60, 45, 1, 0, -1, -60, -2880]) {
  const out = formatLeadTime(m, true) ?? "";
  assert(
    /the time it was booked for/.test(out),
    `every lead phrase names what it is relative to (${m} gave ${JSON.stringify(out)})`,
  );
}

// When the entry did NOT move the call (a reassign, a cancel), the anchor is the
// call itself and cannot differ from any other entry's, so "then" only made the
// line harder to read: "16 hours before the time it was booked for then" on a
// reassignment whose time read 8:00am -> 8:00am (Dan, 2026-09-30).
eq(formatLeadTime(960, false), "16 hours before the call", "unmoved, before -> before the call");
eq(formatLeadTime(1, false), "1 minute before the call", "unmoved, 1 min before");
eq(formatLeadTime(-240, false), "4 hours after the call was due", "unmoved, after -> after it was due");
eq(formatLeadTime(0, false), "at the time of the call", "unmoved, 0 -> at the time of the call");
eq(formatLeadTime(null, false), null, "unmoved, null lead -> null");
for (const m of [2880, 60, 1, 0, -1, -60, -2880]) {
  const out = formatLeadTime(m, false) ?? "";
  assert(/the call/.test(out), `an unmoved phrase still names the call (${m} gave ${JSON.stringify(out)})`);
  assert(!/then/.test(out), `an unmoved phrase carries no moving anchor (${m} gave ${JSON.stringify(out)})`);
}

// --- reasonLabel: code -> human label, with "other" free text + unknown-code fallback ---
eq(
  reasonLabel("cancel", "no_longer_interested", null, OPTS),
  "No longer interested",
  "known cancel code -> its label",
);
eq(
  reasonLabel("reschedule", "other", "Kid got sick", OPTS),
  "Kid got sick",
  "'other' -> the free-text detail",
);
eq(reasonLabel("cancel", "other", null, OPTS), "Other", "'other' with no detail -> 'Other'");
eq(
  reasonLabel("reassign", "owner_reassignment", null, OPTS),
  "Owner reassignment",
  "known reassign code -> its label",
);
eq(
  reasonLabel("cancel", "api_cancellation", null, OPTS),
  "Api cancellation",
  "unknown/system code (absent from options) -> humanized fallback",
);
// #346: a RENAMED or custom code resolves to its exact stored label, not a guess.
{
  const renamed: Record<ReasonAction, ReasonOption[]> = {
    reschedule: RESCHEDULE_REASONS,
    cancel: [
      { code: "no_longer_interested", label: "Not interested anymore" },
      { code: "cost_concerns", label: "Cost concerns" },
      { code: "other", label: "Other" },
    ],
    reassign: REASSIGN_REASONS,
  };
  eq(
    reasonLabel("cancel", "no_longer_interested", null, renamed),
    "Not interested anymore",
    "a renamed code renders its current stored label, not the old one",
  );
  eq(
    reasonLabel("cancel", "cost_concerns", null, renamed),
    "Cost concerns",
    "a custom admin-added code renders its exact stored label",
  );
}

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
const rv = toBookingEventView(reschedule, nameOf, OPTS);
eq(rv.actionLabel, "Rescheduled", "reschedule -> actionLabel Rescheduled");
eq(rv.who, "Dan Wright (admin)", "reschedule who");
eq(rv.reason, "Schedule conflict", "reschedule reason label");
eq(rv.lead, "2 days before the time it was booked for then", "reschedule lead names its anchor");
// #1916: the INSTANTS, not a string formatted in a zone the server guessed. The
// server cannot know who is reading, so the client renders them in the viewer's
// zone, labelled (ViewerTime).
eq(
  rv.timeChange,
  { from: "2026-07-03T18:00:00Z", to: "2026-07-05T18:00:00Z" },
  "reschedule timeChange carries the from and to instants",
);
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
const av = toBookingEventView(reassign, nameOf, OPTS);
eq(av.actionLabel, "Reassigned", "reassign -> actionLabel Reassigned");
eq(av.agentChange, "Jo Lee → Dan Wright", "reassign agentChange from -> to (names)");
eq(av.timeChange, null, "reassign with no time change -> null");
eq(av.reason, "Coverage (agent unavailable)", "reassign reason label");

// The case in Dan's screenshot: a reassign records the SAME time on both sides,
// so the time did not move and the lead names the call, not "then".
const sameTimeReassign = toBookingEventView(
  {
    ...reassign,
    initiator: "system",
    from_starts_at: "2026-10-01T12:00:00Z",
    to_starts_at: "2026-10-01T12:00:00Z",
    lead_time_minutes: 964,
  },
  nameOf,
  OPTS,
);
eq(sameTimeReassign.lead, "16 hours before the call", "same time reassign lead names the call");
// And it draws no "8:00am -> 8:00am" line: a time that did not change is not a
// change, and the same fact twice on one entry (L605) is what Dan saw next.
eq(sameTimeReassign.timeChange, null, "same time reassign shows no time change");
// Same instant written two ways is still the same time.
eq(
  toBookingEventView(
    { ...reassign, from_starts_at: "2026-10-01T12:00:00Z", to_starts_at: "2026-10-01T12:00:00.000+00:00", lead_time_minutes: 60 },
    nameOf,
    OPTS,
  ).lead,
  "1 hour before the call",
  "one instant in two spellings is not a move",
);
eq(
  toBookingEventView(
    { ...reassign, from_starts_at: "2026-10-01T12:00:00Z", to_starts_at: "2026-10-01T12:00:00.000+00:00" },
    nameOf,
    OPTS,
  ).timeChange,
  null,
  "one instant in two spellings draws no time change",
);

const cancel: BookingEvent = {
  ...base,
  action: "cancelled",
  initiator: "customer",
  actor_user_id: null,
  reason_code: "no_longer_interested",
  lead_time_minutes: -240,
};
const cv = toBookingEventView(cancel, nameOf, OPTS);
eq(cv.actionLabel, "Cancelled", "cancel -> actionLabel Cancelled");
eq(cv.who, "Customer", "cancel who = Customer");
eq(cv.lead, "4 hours after the call was due", "cancel does not move the call, so its lead names the call");
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
const views = buildHistoryViews([older, newer], roster, OPTS);
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
const uv = buildHistoryViews([unknown], roster, OPTS);
eq(uv[0].agentChange, "Unknown user → Dan Wright", "id absent from roster -> 'Unknown user'");

eq(buildHistoryViews([], roster, OPTS).length, 0, "no events -> empty list");

finish();
