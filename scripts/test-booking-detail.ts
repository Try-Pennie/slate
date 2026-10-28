import {
  bookingIsActionable,
  bookingDetailView,
  loadBookingDetail,
  bookingDetailHref,
  type BookingDetailInput,
  type BookingDetailPageDeps,
} from "../src/lib/booking/detail.ts";
import { rosterNameResolver } from "../src/lib/booking/event-display.ts";
import type { Booking } from "../src/lib/db/types.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const nameOf = rosterNameResolver([
  { id: "u1", name: "Jamie Smith", email: "jamie@x.co" },
  { id: "u2", name: null, email: "ana@x.co" },
]);

const base: BookingDetailInput = {
  attendee_name: "Jane Doe",
  attendee_email: "jane@acme.co",
  attendee_phone: "+15551234",
  status: "confirmed",
  starts_at: "2026-07-03T18:00:00Z",
  ends_at: "2026-07-03T18:30:00Z",
  original_starts_at: null,
  assigned_user_id: "u1",
  routing_trace: {
    bucket_code: "DBT-01",
    bucket_id: "bk",
    considered: ["u1", "u2"],
    chosen_user_id: "u1",
    fallback_applied: false,
  },
  source: "offerhub",
};

const v = bookingDetailView(base, nameOf);

// #2072: where the booking came from, with the cal.com event type it would have
// been booked into, so an admin can read either name. The three non page states
// each say their own thing: a booking older than the field, a link with no
// source, and a link naming a page Slate does not know are three different facts.
eq(v.source, "/offerportal, cal.com event type call", "a page source shows the page and its legacy event type");
eq(
  bookingDetailView({ ...base, source: "booking-agent-eligible" }, nameOf).source,
  "/booking, eligible for the AI agent, cal.com event type connect",
  "the AI agent eligible booking page reads as connect",
);
eq(
  bookingDetailView({ ...base, source: "not-given" }, nameOf).source,
  "No source on the link",
  "not-given says the link carried none, with no event type",
);
eq(
  bookingDetailView({ ...base, source: "unrecognised" }, nameOf).source,
  "A source Slate does not know",
  "unrecognised is its own statement, distinct from not-given",
);
eq(
  bookingDetailView({ ...base, source: null }, nameOf).source,
  "Booked before sources were recorded",
  "a null source is a booking older than the field, not a link without one",
);
eq(v.attendee, "Jane Doe", "attendee name preferred");
eq(v.email, "jane@acme.co", "email passed through");
eq(v.status, "confirmed", "status passed through");
eq(v.agentName, "Jamie Smith", "assigned agent resolved");
eq(v.bucketCode, "DBT-01", "bucket code from routing_trace");
// #1916: instants, not strings formatted in Eastern. The page renders them in
// the viewer's zone, labelled, through ViewerTime.
eq(v.startsAt, base.starts_at, "start carried as the instant");
eq(v.endsAt, base.ends_at, "end carried as the instant");
eq(v.rescheduledFrom, null, "no original time -> not rescheduled");
assert(v.trace !== null, "trace present");
// #1943: WHO was considered, not how many. The ids were on the page already and
// it printed their length. Resolved through the SHARED roster resolver, so an
// agent with no name falls back to their email exactly as every other surface
// does, and an id the roster is missing says so rather than rendering eight hex
// characters (L67).
eq(
  v.trace!.considered.join(", "),
  "Jamie Smith, ana@x.co",
  "the considered agents are named, with the same fallbacks as everywhere else",
);
// And an id the roster does not hold says so rather than rendering as a name or
// as eight hex characters. An unresolved id is a DETECTION that the roster this
// page was handed is missing somebody, not a name (L67), and the smoke agents'
// patterned ids are why truncating was worse than nothing (#1914).
{
  const missing = bookingDetailView(
    {
      ...base,
      routing_trace: { ...base.routing_trace!, considered: ["u1", "nobody-here"] },
    },
    nameOf,
  );
  eq(
    missing.trace!.considered.join(", "),
    "Jamie Smith, Unknown user",
    "an id the roster is missing is named as unknown, never as hex",
  );
  assert(
    !missing.trace!.considered.some((n) => /^[0-9a-f]{6,}$/i.test(n)),
    "and no considered entry is a raw id",
  );
}
eq(v.trace!.fallbackApplied, false, "fallback flag");
eq(v.trace!.reassignments.length, 0, "no reassignments");

// Attendee fallback when name is null.
eq(
  bookingDetailView({ ...base, attendee_name: null }, nameOf).attendee,
  "jane@acme.co",
  "attendee falls back to email",
);

// Unassigned agent.
eq(
  bookingDetailView({ ...base, assigned_user_id: null }, nameOf).agentName,
  "Unassigned",
  "null agent -> Unassigned",
);

// Rescheduled: original differs from current.
const resched = bookingDetailView(
  { ...base, original_starts_at: "2026-07-01T18:00:00Z" },
  nameOf,
);
eq(
  resched.rescheduledFrom,
  "2026-07-01T18:00:00Z",
  "rescheduledFrom is the original start instant",
);

// Reassignment trace resolves names.
const withReassign = bookingDetailView(
  {
    ...base,
    routing_trace: {
      ...base.routing_trace!,
      fallback_applied: true,
      reassignments: [{ from: "u1", to: "u2", at: "2026-07-02T00:00:00Z" }],
    },
  },
  nameOf,
);
eq(withReassign.trace!.fallbackApplied, true, "fallback true surfaced");
eq(withReassign.trace!.reassignments.length, 1, "one reassignment");
eq(withReassign.trace!.reassignments[0].from, "Jamie Smith", "reassignment from name");
eq(withReassign.trace!.reassignments[0].to, "ana@x.co", "reassignment to name (email fallback)");

// Null routing trace -> null trace, null bucket.
const noTrace = bookingDetailView({ ...base, routing_trace: null }, nameOf);
eq(noTrace.trace, null, "no routing_trace -> null trace");
eq(noTrace.bucketCode, null, "no routing_trace -> null bucket");

// A call a coordinator books on the placeholder (kind staff_placed, milestone 75) is
// never routed, so it carries no routing_trace. Its bucket still comes from the row
// it is stored in: without it the page showed "Bucket: not set" and the move panel
// asked for no times at all, so it read "No open times" and the call could not be
// moved off the placeholder (found in the #4206 drill).
const placed = bookingDetailView(
  { ...base, routing_trace: null, buckets: { code: "XBC-7" } },
  nameOf,
);
eq(placed.bucketCode, "XBC-7", "no routing_trace -> the stored bucket's code");
eq(placed.trace, null, "and still no routing summary, since nothing was routed");
// A routed call keeps the bucket routing chose, which the row's own bucket must not override.
eq(
  bookingDetailView({ ...base, buckets: { code: "OTHER" } }, nameOf).bucketCode,
  "DBT-01",
  "a routing_trace bucket wins over the stored one",
);

// --- bookingDetailHref: the one link target the admin row + lookup both use ---
eq(bookingDetailHref("bk1"), "/admin/bookings/bk1", "detail href for a booking id");
eq(
  bookingDetailHref("a/b c"),
  "/admin/bookings/a%2Fb%20c",
  "detail href url-encodes the id segment",
);

// --- loadBookingDetail: the page's guard + tenant-scoped load, as a decision ---
const fullBooking = { ...base, id: "bk1", assigned_user_id: "u1" } as unknown as Booking;
function deps(over: Partial<BookingDetailPageDeps>): BookingDetailPageDeps {
  return {
    role: "manager",
    orgId: "org1",
    canManage: () => true,
    oooOnly: () => false,
    getBooking: async () => fullBooking,
    getRoster: async () => [{ id: "u1", name: "Jamie Smith", email: "jamie@x.co" }],
    ...over,
  };
}

async function main() {
  // Not a manager -> forbidden, and no booking read happens.
  let read = false;
  const forbidden = await loadBookingDetail(
    "bk1",
    deps({ canManage: () => false, getBooking: async () => ((read = true), fullBooking) }),
  );
  eq(forbidden.kind, "forbidden", "non-manager -> forbidden");
  assert(!read, "forbidden path performs no booking read");

  // OOO-only role -> ooo (redirect to the OOO surface).
  const ooo = await loadBookingDetail("bk1", deps({ oooOnly: () => true }));
  eq(ooo.kind, "ooo", "ooo-only role -> ooo");

  // #2699: the console gate answers before the role check, so a viewer who is
  // BOTH held out of the console and below manager is redirected like every
  // other console route does, not refused with a role message.
  const both = await loadBookingDetail(
    "bk1",
    deps({ canManage: () => false, oooOnly: () => true }),
  );
  eq(both.kind, "ooo", "held out AND below manager -> ooo, not forbidden");

  // Booking absent or in another org -> notfound; getBooking is org-scoped.
  let scoped: { id: string; orgId: string } | null = null;
  const missing = await loadBookingDetail(
    "bk1",
    deps({
      getBooking: async (id, orgId) => {
        scoped = { id, orgId };
        return null;
      },
    }),
  );
  eq(missing.kind, "notfound", "no booking -> notfound");
  eq(scoped!.orgId, "org1", "getBooking is tenant-scoped");
  eq(scoped!.id, "bk1", "getBooking receives the id");

  // Found -> ok, with the resolved detail view.
  const ok = await loadBookingDetail("bk1", deps({}));
  eq(ok.kind, "ok", "found -> ok");
  if (ok.kind === "ok") {
    eq(ok.booking.id, "bk1", "ok carries the booking");
    eq(ok.view.agentName, "Jamie Smith", "ok view resolves the agent name");
  }

  // --- whether there are any actions at all (#1943) ----------------------------
//
// Dan: "what does actions canceled mean? I can see it was canceled from the
// history." It was a card headed Actions containing the single word Cancelled,
// which is the control saying "there are none" by printing a status the page
// already states twice. The page drops the card entirely now, and both it and
// the control read THIS predicate, so they cannot disagree and leave an empty
// card behind.
//
// Driven here rather than only in the browser: production holds no confirmed or
// rescheduled booking at all today (298 cancelled and 2 completed), so the
// actionable case cannot be seen on real data.
assert(bookingIsActionable("confirmed"), "a confirmed booking can still be changed");
assert(bookingIsActionable("rescheduled"), "and so can a rescheduled one");
assert(!bookingIsActionable("cancelled"), "a cancelled booking cannot");
assert(!bookingIsActionable("completed"), "and neither can a completed one, which read just as oddly");

finish();
}

void main();
