import {
  bookingDetailView,
  loadBookingDetail,
  bookingDetailHref,
  type BookingDetailInput,
  type BookingDetailPageDeps,
} from "../src/lib/booking/detail.ts";
import { rosterNameResolver } from "../src/lib/booking/event-display.ts";
import { formatSlotDay, formatSlotTime } from "../src/lib/booking/slot-label.ts";
import type { Booking } from "../src/lib/db/types.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const TZ = "America/New_York";
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
};

const v = bookingDetailView(base, nameOf, TZ);
eq(v.attendee, "Jane Doe", "attendee name preferred");
eq(v.email, "jane@acme.co", "email passed through");
eq(v.status, "confirmed", "status passed through");
eq(v.agentName, "Jamie Smith", "assigned agent resolved");
eq(v.bucketCode, "DBT-01", "bucket code from routing_trace");
eq(
  v.when,
  `${formatSlotDay(base.starts_at, TZ)}, ${formatSlotTime(base.starts_at, TZ)}`,
  "start formatted in ET",
);
eq(v.rescheduledFrom, null, "no original time -> not rescheduled");
assert(v.trace !== null, "trace present");
eq(v.trace!.considered, 2, "considered count");
eq(v.trace!.fallbackApplied, false, "fallback flag");
eq(v.trace!.reassignments.length, 0, "no reassignments");

// Attendee fallback when name is null.
eq(
  bookingDetailView({ ...base, attendee_name: null }, nameOf, TZ).attendee,
  "jane@acme.co",
  "attendee falls back to email",
);

// Unassigned agent.
eq(
  bookingDetailView({ ...base, assigned_user_id: null }, nameOf, TZ).agentName,
  "Unassigned",
  "null agent -> Unassigned",
);

// Rescheduled: original differs from current.
const resched = bookingDetailView(
  { ...base, original_starts_at: "2026-07-01T18:00:00Z" },
  nameOf,
  TZ,
);
eq(
  resched.rescheduledFrom,
  `${formatSlotDay("2026-07-01T18:00:00Z", TZ)}, ${formatSlotTime("2026-07-01T18:00:00Z", TZ)}`,
  "rescheduledFrom is the original start, formatted",
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
  TZ,
);
eq(withReassign.trace!.fallbackApplied, true, "fallback true surfaced");
eq(withReassign.trace!.reassignments.length, 1, "one reassignment");
eq(withReassign.trace!.reassignments[0].from, "Jamie Smith", "reassignment from name");
eq(withReassign.trace!.reassignments[0].to, "ana@x.co", "reassignment to name (email fallback)");

// Null routing trace -> null trace, null bucket.
const noTrace = bookingDetailView({ ...base, routing_trace: null }, nameOf, TZ);
eq(noTrace.trace, null, "no routing_trace -> null trace");
eq(noTrace.bucketCode, null, "no routing_trace -> null bucket");

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
    timeZone: TZ,
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

  finish();
}

void main();
